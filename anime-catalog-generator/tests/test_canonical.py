"""CanonicalAnimeResolver con datos reales de AniList y mappings reales (recortados)."""

from __future__ import annotations

import copy

from anime_catalog.catalog.canonical import CanonicalAnimeResolver, choose_root
from anime_catalog.config import CanonicalConfig
from anime_catalog.mapping.index import MappingIndex
from anime_catalog.models import AnimeEntry, FuzzyDate, Relation


def make_resolver(index_db, entries, **cfg):
    by_uid = {e.uid: e for e in entries.values()}

    def fetch(uids):
        return {u: by_uid[u] for u in uids if u in by_uid}

    return CanonicalAnimeResolver(MappingIndex(index_db), CanonicalConfig(**cfg), fetch, db=index_db)


def group_of(groups, uid):
    return next(g for g in groups if uid in g.members)


def test_attack_on_titan_seasons_collapse_to_2013(index_db, entries):
    # Semillas: solo temporadas posteriores (como al filtrar 2020-2026).
    seeds = {e.uid: e for i, e in entries.items() if i in (110277, 131681)}
    groups = make_resolver(index_db, entries).resolve(seeds)
    g = group_of(groups, "anilist:110277")
    assert g.root.uid == "anilist:16498"
    assert g.root.start_date.year == 2013
    assert g.show_ids == {1429}
    for uid in ("anilist:20958", "anilist:99147", "anilist:104578", "anilist:131681"):
        assert uid in g.members
    assert any("misma serie TMDB [1429]" in c for c in g.criteria)


def test_attack_on_titan_ova_prequel_released_later_does_not_become_root(index_db, entries):
    # AniList marca la OVA 20811 como PREQUEL de la temporada 1 aunque se estrenó después.
    seeds = {e.uid: e for i, e in entries.items() if i in (16498, 20811)}
    groups = make_resolver(index_db, entries).resolve(seeds)
    g = group_of(groups, "anilist:16498")
    assert g.root.uid == "anilist:16498"


def test_jujutsu_kaisen_single_entry(index_db, entries):
    seeds = {e.uid: e for i, e in entries.items() if i in (145064, 172463)}
    groups = make_resolver(index_db, entries).resolve(seeds)
    g = group_of(groups, "anilist:145064")
    assert g.root.uid == "anilist:113415"
    assert g.show_ids == {95479}
    assert {"anilist:113415", "anilist:145064", "anilist:172463"} <= set(g.members)


def test_demon_slayer_series_and_movie_are_separate(index_db, entries):
    seeds = {e.uid: e for i, e in entries.items() if i in (101922, 129874, 142329, 145139, 166240, 112151)}
    groups = make_resolver(index_db, entries).resolve(seeds)
    series = group_of(groups, "anilist:166240")
    movie = group_of(groups, "anilist:112151")
    assert series.root.uid == "anilist:101922" and series.kind == "series"
    assert len(series.members) == 5
    assert movie.kind == "movie" and list(movie.members) == ["anilist:112151"]


def test_one_piece_keeps_1999_series_and_separates_prequel_ona_and_remake(index_db, entries):
    seeds = {e.uid: e for i, e in entries.items() if i in (21, 167404, 171630)}
    groups = make_resolver(index_db, entries).resolve(seeds)
    op = group_of(groups, "anilist:21")
    assert op.root.uid == "anilist:21" and op.root.start_date.year == 1999
    assert set(op.members) == {"anilist:21"}
    # MONSTERS (ONA sin mapping, precuela) y THE ONE PIECE (remake) quedan como obras propias.
    assert group_of(groups, "anilist:167404").root.uid == "anilist:167404"
    assert group_of(groups, "anilist:171630").root.uid == "anilist:171630"


def test_hunter_x_hunter_remake_preserved(index_db, entries):
    seeds = {e.uid: e for i, e in entries.items() if i in (136, 11061)}
    groups = make_resolver(index_db, entries).resolve(seeds)
    assert group_of(groups, "anilist:136") is not group_of(groups, "anilist:11061")


def test_spinoff_preserved(index_db, entries):
    seeds = {e.uid: e for i, e in entries.items() if i in (16498, 21281)}
    groups = make_resolver(index_db, entries).resolve(seeds)
    assert group_of(groups, "anilist:21281").root.uid == "anilist:21281"
    assert "anilist:21281" not in group_of(groups, "anilist:16498").members


def _unmapped_sequel(prequel: AnimeEntry, new_id: int, year: int) -> AnimeEntry:
    e = AnimeEntry(provider="anilist", anilist_id=new_id, title_romaji=f"Secuela {new_id}", format="TV",
                   start_date=FuzzyDate(year=year), status="NOT_YET_RELEASED",
                   relations=[Relation(relation_type="PREQUEL", target_uid=prequel.uid, target_format=prequel.format,
                                       target_start=prequel.start_date)])
    return e


def test_unmapped_new_season_joins_its_series(index_db, entries):
    jjk3 = entries[172463]
    new = _unmapped_sequel(jjk3, 99999901, 2027)
    pool = {**entries, 99999901: new}
    groups = make_resolver(index_db, pool).resolve({new.uid: new})
    g = group_of(groups, new.uid)
    assert g.root.uid == "anilist:113415"


def test_unmapped_entry_never_bridges_two_different_series(index_db, entries):
    # Una entrada sin mapping relacionada con dos series distintas no puede unirlas.
    aot, ds = entries[16498], entries[101922]
    bridge = AnimeEntry(provider="anilist", anilist_id=99999902, format="TV", start_date=FuzzyDate(year=2030),
                        relations=[Relation(relation_type="PREQUEL", target_uid=aot.uid, target_format="TV", target_start=aot.start_date),
                                   Relation(relation_type="PREQUEL", target_uid=ds.uid, target_format="TV", target_start=ds.start_date)])
    pool = {**entries, 99999902: bridge}
    groups = make_resolver(index_db, pool).resolve({bridge.uid: bridge, aot.uid: aot, ds.uid: ds})
    assert group_of(groups, aot.uid) is not group_of(groups, ds.uid)


def test_same_tmdb_id_merges_without_relation(index_db, entries):
    # Se eliminan las relaciones: el índice inverso/TMDB ID común reúne las temporadas igualmente.
    s4 = copy.deepcopy(entries[110277])
    s4.relations = []
    pool = {**entries, 110277: s4}
    groups = make_resolver(index_db, pool).resolve({s4.uid: s4})
    g = group_of(groups, s4.uid)
    assert g.root.uid == "anilist:16498"
    assert any("mismo TMDB TV ID 1429" in c for c in g.criteria)


def test_collapse_disabled_keeps_entries_apart(index_db, entries):
    seeds = {e.uid: e for i, e in entries.items() if i in (16498, 20958)}
    groups = make_resolver(index_db, entries, collapse_seasons=False).resolve(seeds)
    assert group_of(groups, "anilist:16498") is not group_of(groups, "anilist:20958")


def test_choose_root_prefers_earliest_broadcast():
    ova = AnimeEntry(provider="anilist", anilist_id=1, format="OVA", start_date=FuzzyDate(year=2000))
    tv = AnimeEntry(provider="anilist", anilist_id=2, format="TV", start_date=FuzzyDate(year=2001))
    tv2 = AnimeEntry(provider="anilist", anilist_id=3, format="TV", start_date=FuzzyDate(year=2005))
    assert choose_root([ova, tv2, tv]).anilist_id == 2
