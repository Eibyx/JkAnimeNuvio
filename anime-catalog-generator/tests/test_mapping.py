"""MappingResolver: prioridades, índices inversos, puente AniDB, fallbacks, conflictos y overrides."""

from __future__ import annotations

import pytest

from anime_catalog.config import MappingConfig
from anime_catalog.mapping.index import MappingIndex
from anime_catalog.mapping.resolver import MappingResolver
from anime_catalog.models import AnimeEntry, FuzzyDate, MappingStatus
from anime_catalog.providers.tmdb import TMDBClient
from anime_catalog.storage.cache import Cache
from anime_catalog.storage.database import Database

from .conftest import FakeTMDB, no_sleep


def resolver(db, tmdb: FakeTMDB | None = None, **cfg) -> MappingResolver:
    client = None
    if tmdb is not None:
        client = TMDBClient("https://api.tmdb.test/3", Cache(db), api_key="k", transport=tmdb.transport(), sleep=no_sleep)
    return MappingResolver(db, MappingIndex(db), MappingConfig(**cfg), client)


def entry(aid=None, mal=None, fmt="TV", year=2020, title="X") -> AnimeEntry:
    return AnimeEntry(provider="anilist" if aid else "myanimelist", anilist_id=aid, mal_id=mal, format=fmt,
                      start_date=FuzzyDate(year=year), title_romaji=title)


def add_rows(db: Database, rows: list[tuple]) -> None:
    db.conn.executemany(
        "INSERT INTO mapping_index(source, src_provider, src_id, src_scope, dst_provider, dst_id, dst_scope, detail) VALUES(?,?,?,?,?,?,?,?)",
        rows,
    )


def test_anilist_to_tmdb_direct_one_piece(index_db):
    r = resolver(index_db).resolve_entry(entry(21, 21, year=1999, title="ONE PIECE"))
    assert (r.media_type, r.tmdb_id) == ("tv", 37854)
    assert r.source == "anibridge"
    assert r.status == MappingStatus.HIGH_CONFIDENCE  # sin TMDB no puede ser CONFIRMED
    assert r.season == 1


def test_mal_only_entry_resolves(index_db):
    r = resolver(index_db).resolve_entry(entry(None, 16498, year=2013))
    assert (r.media_type, r.tmdb_id) == ("tv", 1429)


def test_multiple_seasons_map_to_same_show(index_db):
    res = resolver(index_db)
    ids = {res.resolve_entry(entry(i)).tmdb_id for i in (16498, 20958, 99147, 104578, 110277, 131681)}
    assert ids == {1429}


def test_movie_maps_to_movie_not_show(index_db):
    r = resolver(index_db).resolve_entry(entry(112151, fmt="MOVIE"))
    assert r.media_type == "movie" and r.tmdb_id == 635302
    r2 = resolver(index_db).resolve_entry(entry(199, fmt="MOVIE", year=2001))
    assert (r2.media_type, r2.tmdb_id) == ("movie", 129)


def test_anilist_via_anidb_to_tmdb(tmp_path):
    db = Database(tmp_path / "x.db")
    add_rows(db, [
        ("fribb", "anilist", "500", None, "anidb", "900", None, ""),
        ("anime_lists", "anidb", "900", None, "tmdb_show", "7777", "s1", ""),
    ])
    r = resolver(db, primary="anime_lists", fallbacks=["fribb"]).resolve_entry(entry(500))
    assert (r.media_type, r.tmdb_id) == ("tv", 7777)
    assert any("vía anidb:900" in c["via"] for c in r.candidates)


def test_reverse_only_mapping_uses_inverse_index(tmp_path):
    db = Database(tmp_path / "x.db")
    # Solo existe tmdb_show:4242:s1 -> anilist:600 (dirección contraria).
    add_rows(db, [("anibridge", "tmdb_show", "4242", "s1", "anilist", "600", None, "eps=12;1-12>1-12")])
    r = resolver(db).resolve_entry(entry(600))
    assert r.tmdb_id == 4242
    assert any("relación inversa" in e for e in r.evidence)
    assert r.confidence < 0.95


def test_missing_mapping_is_unmapped(index_db):
    r = resolver(index_db).resolve_entry(entry(99999999))
    assert r.status == MappingStatus.UNMAPPED and r.tmdb_id is None


def test_ambiguous_multiple_shows_from_primary_is_conflict(tmp_path):
    db = Database(tmp_path / "x.db")
    add_rows(db, [
        ("anibridge", "anilist", "700", None, "tmdb_show", "1", "s1", "eps=6;1-6>1-6"),
        ("anibridge", "anilist", "700", None, "tmdb_show", "2", "s1", "eps=6;7-12>1-6"),
    ])
    r = resolver(db).resolve_entry(entry(700))
    assert r.status == MappingStatus.CONFLICT and r.tmdb_id is None


def test_conflict_between_sources_without_tmdb_goes_to_review(index_db):
    # Datos reales: AniBridge y Fribb discrepan para la película 1047.
    r = resolver(index_db).resolve_entry(entry(1047, fmt="MOVIE", year=1995))
    assert r.status == MappingStatus.CONFLICT
    assert r.conflicts


def test_conflict_resolved_by_tmdb_validation(index_db, fake_tmdb):
    fake_tmdb.add("movie", 1658826, "On Your Mark", "1995-07-15")
    fake_tmdb.add("movie", 10840, "Completely different", "1980-01-01", genres=(18,), lang="en")
    e = entry(1047, fmt="MOVIE", year=1995, title="On Your Mark")
    r = resolver(index_db, fake_tmdb).resolve_entry(e)
    assert r.tmdb_id == 1658826
    assert r.status in (MappingStatus.HIGH_CONFIDENCE, MappingStatus.CONFIRMED)


def test_movie_with_only_show_mapping_needs_review(tmp_path):
    db = Database(tmp_path / "x.db")
    add_rows(db, [("anibridge", "anilist", "800", None, "tmdb_show", "55", "s0", "eps=1;1>3")])
    r = resolver(db).resolve_entry(entry(800, fmt="MOVIE"))
    assert r.status == MappingStatus.NEEDS_REVIEW and r.tmdb_id is None
    r2 = resolver(db, movie_allow_show_mapping=True).resolve_entry(entry(800, fmt="MOVIE"))
    assert r2.media_type == "tv" and r2.tmdb_id == 55


def test_fribb_multiple_movies_are_parsed(tmp_path):
    from anime_catalog.mapping.fribb import FribbDataset
    import json
    p = tmp_path / "f.json"
    p.write_text(json.dumps([{"anidb_id": 1, "anilist_id": 5, "type": "MOVIE", "themoviedb_id": {"movie": [10, 11]}}]))
    rows = list(FribbDataset(tmp_path).parse(p))
    movies = {r[4] for r in rows if r[3] == "tmdb_movie" and r[0] == "anilist"}
    assert movies == {"10", "11"}


def test_specials_placement_is_not_identity_conflict(index_db):
    # Heya Camp: AniBridge -> serie propia 95213 s1; Fribb -> especial s0 de Yuru Camp (76075).
    r = resolver(index_db).resolve_entry(entry(104461, fmt="TV_SHORT", year=2020))
    assert r.tmdb_id == 95213
    assert r.status == MappingStatus.HIGH_CONFIDENCE
    assert any("diferencia de representación" in e for e in r.evidence)


def test_lineage_not_counted_as_independent(index_db):
    r = resolver(index_db).resolve_entry(entry(16498, year=2013))
    assert any("misma procedencia" in e for e in r.evidence)
    assert r.confidence <= 0.97


def test_tmdb_validation_confirms(index_db, fake_tmdb):
    fake_tmdb.add("tv", 37854, "One Piece", "1999-10-20", original_name="ワンピース", tvdb_id=81797, imdb_id="tt0388629")
    r = resolver(index_db, fake_tmdb).resolve_entry(entry(21, 21, year=1999, title="ONE PIECE"))
    assert r.status == MappingStatus.CONFIRMED
    assert r.validation.checks["tvdb"].startswith("coincide")
    assert r.tvdb_id == 81797 and r.imdb_id == "tt0388629"


def test_tmdb_validation_year_mismatch_needs_review(index_db, fake_tmdb):
    fake_tmdb.add("tv", 37854, "One Piece", "2023-08-31", tvdb_id=81797)
    r = resolver(index_db, fake_tmdb).resolve_entry(entry(21, 21, year=1999, title="ONE PIECE"))
    assert r.status == MappingStatus.NEEDS_REVIEW


def test_tmdb_id_that_does_not_exist_is_unmapped(index_db, fake_tmdb):
    r = resolver(index_db, fake_tmdb).resolve_entry(entry(21, 21, year=1999, title="ONE PIECE"))
    assert r.status == MappingStatus.UNMAPPED and r.tmdb_id is None


def test_tvdb_fallback_via_tmdb_find(tmp_path, fake_tmdb):
    db = Database(tmp_path / "x.db")
    add_rows(db, [("kometa", "anilist", "900", None, "tvdb_show", "31337", "s1", "single;epoffset=0")])
    fake_tmdb.find_results["31337"] = {"tv_results": [{"id": 4444, "name": "Show"}], "movie_results": []}
    fake_tmdb.add("tv", 4444, "Show", "2020-01-01", tvdb_id=31337)
    r = resolver(db, fake_tmdb).resolve_entry(entry(900, year=2020, title="Show"))
    assert (r.tmdb_id, r.source) == (4444, "tmdb_find")
    assert r.status in (MappingStatus.HIGH_CONFIDENCE, MappingStatus.CONFIRMED)


def test_tmdb_find_with_several_candidates_is_conflict(tmp_path, fake_tmdb):
    db = Database(tmp_path / "x.db")
    add_rows(db, [("kometa", "anilist", "901", None, "tvdb_show", "1", "s1", ""), ("kometa", "anilist", "901", None, "imdb", "tt1", None, "")])
    fake_tmdb.find_results["1"] = {"tv_results": [{"id": 1}]}
    fake_tmdb.find_results["tt1"] = {"tv_results": [{"id": 2}]}
    r = resolver(db, fake_tmdb).resolve_entry(entry(901))
    assert r.status == MappingStatus.CONFLICT


def test_title_search_ambiguous_is_not_added(tmp_path, fake_tmdb):
    db = Database(tmp_path / "x.db")
    fake_tmdb.search_results["Kimi no Na wa"] = [
        {"id": 1, "name": "Kimi no Na wa", "first_air_date": "2016-01-01", "genre_ids": [16], "original_language": "ja"},
        {"id": 2, "name": "Kimi no Na wa", "first_air_date": "2016-05-01", "genre_ids": [16], "original_language": "ja"},
    ]
    fake_tmdb.add("tv", 1, "Kimi no Na wa", "2016-01-01")
    fake_tmdb.add("tv", 2, "Kimi no Na wa", "2016-05-01")
    r = resolver(db, fake_tmdb).resolve_entry(entry(902, year=2016, title="Kimi no Na wa"))
    assert r.status == MappingStatus.NEEDS_REVIEW
    assert any("ambigua" in c for c in r.conflicts)


def test_title_search_unique_exact_match(tmp_path, fake_tmdb):
    db = Database(tmp_path / "x.db")
    fake_tmdb.search_results["Unico"] = [
        {"id": 77, "name": "Unico", "first_air_date": "2016-01-01", "genre_ids": [16], "original_language": "ja"},
    ]
    fake_tmdb.add("tv", 77, "Unico", "2016-01-01")
    r = resolver(db, fake_tmdb).resolve_entry(entry(903, year=2016, title="Unico"))
    assert r.tmdb_id == 77 and r.source == "title_search"
    assert r.status == MappingStatus.HIGH_CONFIDENCE


def test_overrides_map_and_exclude(index_db):
    index_db.set_override("anilist:21", "map", "tv", 123, note="prueba")
    r = resolver(index_db).resolve_entry(entry(21, 21))
    assert (r.tmdb_id, r.status, r.source) == (123, MappingStatus.CONFIRMED, "override")
    index_db.set_override("anilist:16498", "exclude")
    assert resolver(index_db).resolve_entry(entry(16498)).status == MappingStatus.EXCLUDED


def test_override_survives_dataset_reindex(index_db, tmp_path):
    from .conftest import load_fixture_index
    index_db.set_override("anilist:21", "map", "tv", 123)
    load_fixture_index(index_db, tmp_path / "again")  # simula una actualización de datasets
    assert resolver(index_db).resolve_entry(entry(21, 21)).tmdb_id == 123


@pytest.mark.parametrize("bad", [{"primary": "nope"}, {"fallbacks": ["x"]}, {"minimum_confidence": 0}])
def test_mapping_config_validation(bad):
    with pytest.raises(Exception):
        MappingConfig(**bad)
