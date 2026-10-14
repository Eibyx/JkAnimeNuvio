"""AnimeFilterEngine: años, décadas, fechas, temporadas, puntuaciones, géneros, tags, estudios y AND/OR/NOT."""

from __future__ import annotations

from datetime import date

import pytest

from anime_catalog.catalog.filters import AnimeFilterEngine, entry_season
from anime_catalog.config import Filters, parse_config
from anime_catalog.models import AnimeEntry, FuzzyDate, Relation, Studio, Tag

TODAY = date(2026, 10, 14)


def mk(**kw) -> AnimeEntry:
    base = dict(provider="anilist", anilist_id=kw.pop("aid", 1), format="TV", status="FINISHED",
                start_date=FuzzyDate(year=2021, month=4, day=10), average_score=80, mean_score=81, genres=["Action"])
    base.update(kw)
    return AnimeEntry(**base)


def engine(**filters) -> AnimeFilterEngine:
    return AnimeFilterEngine(Filters(**filters), today=TODAY)


def ok(eng: AnimeFilterEngine, e: AnimeEntry) -> bool:
    return bool(eng.temporal(e)) and bool(eng.metadata(e))


@pytest.mark.parametrize("year,expected", [(2009, False), (2010, True), (2015, True), (2019, True), (2020, False)])
def test_decade(year, expected):
    assert ok(engine(decades=["2010s"]), mk(start_date=FuzzyDate(year=year))) is expected


def test_interval_end_inclusive_and_multiple_ranges():
    eng = engine(year_ranges=["1990-1999", "2020-2026"])
    assert ok(eng, mk(start_date=FuzzyDate(year=1999, month=12)))
    assert ok(eng, mk(start_date=FuzzyDate(year=2026, month=1, day=5)))
    assert not ok(eng, mk(start_date=FuzzyDate(year=2005)))


def test_specific_years_and_exclusions():
    eng = engine(years=[2018, 2021], exclude_years=[2021])
    assert ok(eng, mk(start_date=FuzzyDate(year=2018)))
    assert not ok(eng, mk(start_date=FuzzyDate(year=2021)))


def test_future_releases_excluded_by_default_and_optional():
    future = mk(start_date=FuzzyDate(year=2026, month=12, day=1), status="NOT_YET_RELEASED")
    assert not engine(start_year=2020, end_year=2026).temporal(future)
    assert engine(start_year=2020, end_year=2026, include_future=True).temporal(future)


def test_unknown_dates_policy():
    e = mk(start_date=FuzzyDate())
    assert not engine(start_year=2020).temporal(e)
    assert engine(start_year=2020, unknown_dates="include").temporal(e)


def test_exact_dates_strict_and_overlap_with_partial_dates():
    year_only = mk(start_date=FuzzyDate(year=2020))
    strict = engine(date_from=date(2020, 6, 1), date_to=date(2026, 12, 31))
    overlap = engine(date_from=date(2020, 6, 1), date_to=date(2026, 12, 31), partial_dates="overlap")
    assert not strict.temporal(year_only)  # [2020-01-01, 2020-12-31] no está entero dentro
    assert overlap.temporal(year_only)
    assert strict.temporal(mk(start_date=FuzzyDate(year=2020, month=6, day=1)))
    assert not strict.temporal(mk(start_date=FuzzyDate(year=2020, month=5, day=31)))


def test_seasons_filter_and_derivation():
    eng = engine(seasons=["SPRING", "FALL"])
    assert eng.temporal(mk(season="SPRING"))
    assert not eng.temporal(mk(season="SUMMER"))
    assert entry_season(mk(season=None, start_date=FuzzyDate(year=2020, month=10))) == "FALL"


def test_score_anilist_and_mal_normalized():
    assert ok(engine(score={"min": 75}), mk(average_score=75))
    assert not ok(engine(score={"min": 75}), mk(average_score=74))
    assert not ok(engine(score={"min": 75}), mk(average_score=None))
    assert ok(engine(score={"min": 75, "missing": "include"}), mk(average_score=None))
    assert ok(engine(score={"field": "meanScore", "min": 81}), mk(mean_score=81))
    mal = mk(mal_score=8.1, mal_scored_by=5000)
    assert ok(engine(score={"provider": "myanimelist", "min": 8.0}), mal)
    assert ok(engine(score={"provider": "myanimelist", "min": 80, "normalize": True}), mal)
    assert not ok(engine(score={"provider": "myanimelist", "min": 8.0, "min_votes": 10000}), mal)


def test_score_scale_validation():
    with pytest.raises(Exception):
        Filters(score={"provider": "myanimelist", "min": 75})  # 75 en escala 0-10
    with pytest.raises(Exception):
        Filters(score={"min": 90, "max": 80})


def test_genres_and_or_not():
    e = mk(genres=["Action", "Fantasy"])
    assert ok(engine(genres={"include": ["Action", "Drama"], "mode": "OR"}), e)
    assert not ok(engine(genres={"include": ["Action", "Drama"], "mode": "AND"}), e)
    assert ok(engine(genres={"include": ["action", "fantasy"], "mode": "AND"}), e)
    assert not ok(engine(genres={"exclude": ["Fantasy"]}), e)


def test_tags_rank_is_relevance_not_score():
    e = mk(tags=[Tag(name="Isekai", rank=95), Tag(name="Magic", rank=40)], average_score=60)
    assert ok(engine(tags={"include": ["Isekai"], "min_rank": 60}), e)
    assert not ok(engine(tags={"include": ["Magic"], "min_rank": 60}), e)
    assert not ok(engine(tags={"include": ["Isekai", "Magic"], "min_rank": 60, "mode": "AND"}), e)
    assert ok(engine(tags={"include": ["Isekai", "Magic"], "min_rank": 60, "mode": "OR"}), e)
    assert not ok(engine(tags={"exclude": ["Magic"]}), e)
    assert ok(engine(tags={"exclude": ["Magic"], "exclude_min_rank": 50}), e)


def test_tag_categories_and_spoilers():
    e = mk(tags=[Tag(name="Time Skip", rank=80, category="Theme-Other", is_spoiler=True)])
    assert ok(engine(tags={"categories_include": ["Theme-Other"]}), e)
    assert not ok(engine(tags={"include": ["Time Skip"], "include_spoilers": False}), e)


def test_studios_main_only_dynamic_names():
    e = mk(studios=[Studio(name="MAPPA", is_main=True), Studio(name="Aniplex", is_main=False, is_animation_studio=False)])
    assert ok(engine(studios={"include": ["mappa"]}), e)
    assert ok(engine(studios={"include": ["Aniplex"]}), e)
    assert not ok(engine(studios={"include": ["Aniplex"], "main_only": True}), e)
    assert not ok(engine(studios={"exclude": ["MAPPA"]}), e)


def test_formats_status_country_source_ranges():
    e = mk(format="ONA", status="RELEASING", country="CN", source="WEB_NOVEL", popularity=5000, episodes=12, duration=24)
    assert not ok(engine(), e)  # por defecto TV + MOVIE
    assert ok(engine(formats=["ONA"]), e)
    assert ok(engine(formats=["ONA"], airing_only=True), e)
    assert not ok(engine(formats=["ONA"], finished_only=True), e)
    assert not ok(engine(formats=["ONA"], country={"include": ["JP"]}), e)
    assert ok(engine(formats=["ONA"], source={"include": ["web_novel"]}), e)
    assert not ok(engine(formats=["ONA"], popularity={"min": 10000}), e)
    assert ok(engine(formats=["ONA"], episodes={"min": 10, "max": 13}, duration={"min": 20}), e)


def test_adult_content_excluded_by_default():
    assert not ok(engine(), mk(is_adult=True))
    assert ok(engine(include_adult=True), mk(is_adult=True))


def test_sequel_spinoff_remake_specials():
    prev = Relation(relation_type="PREQUEL", target_uid="anilist:9", target_format="TV", target_start=FuzzyDate(year=2015))
    seq = mk(relations=[prev])
    assert not ok(engine(exclude_sequels=True), seq)
    spin = mk(relations=[Relation(relation_type="PARENT", target_uid="anilist:9")])
    assert not ok(engine(exclude_spinoffs=True), spin)
    remake = mk(relations=[Relation(relation_type="ALTERNATIVE", target_uid="anilist:9", target_format="TV", target_start=FuzzyDate(year=1999))])
    assert not ok(engine(exclude_remakes=True), remake)
    assert not ok(engine(formats=["SPECIAL"], exclude_specials=True), mk(format="SPECIAL"))


def test_compilation_detected_from_summary_relation(entries):
    # AoT 2013 declara Chronicle (119113) como SUMMARY.
    eng = engine(formats=["MOVIE"], exclude_compilations=True)
    eng.known = {e.uid: e for e in entries.values()}
    assert not eng.metadata(entries[119113])
    assert eng.metadata(entries[112151])  # Mugen Train no es un recopilatorio


def test_expression_and_or_not():
    cfg = parse_config({
        "catalog": {"name": "x"},
        "filters": {"expression": {"and": [
            {"or": [{"genres": {"include": ["Fantasy"]}}, {"tags": {"include": ["Magic"], "min_rank": 50}}]},
            {"not": {"genres": {"include": ["Horror"]}}},
        ]}},
    })
    eng = AnimeFilterEngine(cfg.filters, today=TODAY)
    assert eng.metadata(mk(genres=["Fantasy"]))
    assert eng.metadata(mk(genres=["Drama"], tags=[Tag(name="Magic", rank=70)]))
    assert not eng.metadata(mk(genres=["Drama"], tags=[Tag(name="Magic", rank=10)]))
    assert not eng.metadata(mk(genres=["Fantasy", "Horror"]))


def test_exclusion_reasons_are_reported():
    v = engine(score={"min": 90}, genres={"include": ["Drama"]}).metadata(mk())
    assert not v and len(v.reasons) == 2
