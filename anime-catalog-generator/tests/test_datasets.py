"""Datasets de mappings: parsers con datos reales, validación de esquema, ETag, rollback y overrides."""

from __future__ import annotations

import json

import httpx

from anime_catalog.mapping.anibridge import AniBridgeDataset
from anime_catalog.mapping.anime_lists import AnimeListsDataset
from anime_catalog.mapping.kometa import KometaDataset
from anime_catalog.mapping.updater import MappingUpdater
from anime_catalog.storage.database import Database

from .conftest import FIXTURES, no_sleep


class SmallAniBridge(AniBridgeDataset):
    def min_rows(self) -> int:
        return 10


def test_anibridge_descriptors_are_directional(tmp_path):
    rows = list(AniBridgeDataset(tmp_path).parse(FIXTURES / "anibridge_mappings.json"))
    fwd = [r for r in rows if r[0] == "anilist" and r[1] == "21" and r[3] == "tmdb_show"]
    assert {r[4] for r in fwd} == {"37854"}
    assert {r[5] for r in fwd} >= {"s1", "s2"}
    rev = [r for r in rows if r[0] == "tmdb_show" and r[1] == "37854" and r[3] == "anilist"]
    assert rev and rev[0][2] is not None  # el ámbito de origen (temporada) se conserva


def test_kometa_comma_separated_ids(tmp_path):
    p = tmp_path / "k.json"
    p.write_text(json.dumps({"9826": {"tvdb_id": 267440, "tvdb_season": 0, "tvdb_epoffset": 0, "mal_id": "18397,25781,36106",
                                      "anilist_id": 18397, "imdb_id": "tt1,tt2"},
                             "69": {"tvdb_id": 81797, "tvdb_season": -1, "tvdb_epoffset": 0, "mal_id": 21, "anilist_id": 21}}))
    rows = list(KometaDataset(tmp_path).parse(p))
    mal_srcs = {r[1] for r in rows if r[0] == "mal" and r[3] == "tvdb_show"}
    assert mal_srcs == {"18397", "25781", "36106", "21"}
    assert ("anilist", "21", None, "tvdb_show", "81797", "sa", "single;epoffset=0") in rows
    assert any(r[3] == "imdb" and r[4] == "tt2" for r in rows)
    assert any("multi" in (r[6] or "") for r in rows if r[1] == "18397")


def test_anime_lists_xml(tmp_path):
    p = tmp_path / "a.xml"
    p.write_text('<?xml version="1.0"?><anime-list>'
                 '<anime anidbid="69" tvdbid="81797" defaulttvdbseason="a" tmdbtv="37854" tmdbseason="a" tmdbid="" imdbid=""/>'
                 '<anime anidbid="112" tvdbid="movie" defaulttvdbseason="1" tmdbtv="" tmdbseason="" tmdbid="129" imdbid="tt0245429"/>'
                 '</anime-list>')
    rows = list(AnimeListsDataset(tmp_path).parse(p))
    assert ("anidb", "69", None, "tmdb_show", "37854", "sa", "") in rows
    assert any(r[3] == "tmdb_movie" and r[4] == "129" for r in rows)
    assert not any(r[3] == "tvdb_show" and r[1] == "112" for r in rows)


def test_anime_lists_rejects_entities(tmp_path):
    p = tmp_path / "a.xml"
    p.write_text('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><anime-list></anime-list>')
    db = Database(tmp_path / "d.db")
    res = AnimeListsDataset(tmp_path).install(db, p, {})
    assert res.status == "failed"


def _transport(payloads: list[tuple[int, bytes, dict[str, str]]]):
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        status, body, headers = payloads[min(len(calls) - 1, len(payloads) - 1)]
        return httpx.Response(status, content=body, headers=headers)

    return httpx.MockTransport(handler), calls


def test_update_with_etag_schema_change_and_rollback(tmp_path, monkeypatch):
    monkeypatch.setitem(__import__("anime_catalog.mapping.index", fromlist=["x"]).DATASET_CLASSES, "anibridge", SmallAniBridge)
    good = (FIXTURES / "anibridge_mappings.json").read_bytes()
    data = json.loads(good)
    data["anilist:21"]["tmdb_show:11111:s1"] = {"1": "1"}
    good2 = json.dumps(data).encode()
    broken = json.dumps({"$meta": {"schema_version": "4.0.0"}, "anilist:1": {}}).encode()
    transport, calls = _transport([
        (200, good, {"ETag": '"v1"'}),
        (304, b"", {}),
        (200, broken, {"ETag": '"v2"'}),
        (200, good2, {"ETag": '"v3"'}),
    ])
    db = Database(tmp_path / "d.db")
    up = MappingUpdater(db, tmp_path / "ds", transport=transport, sleep=no_sleep)

    r1 = up.update(["anibridge"])[0]
    assert r1.status == "updated" and r1.version.startswith("3.0.3")
    n1 = db.conn.execute("SELECT COUNT(*) FROM mapping_index WHERE source='anibridge'").fetchone()[0]

    r2 = up.update(["anibridge"])[0]
    assert r2.status == "unchanged"
    assert calls[1].headers.get("If-None-Match") == '"v1"'

    db.set_override("anilist:21", "map", "tv", 999)
    r3 = up.update(["anibridge"])[0]
    assert r3.status == "failed" and "4.0.0" in r3.message
    assert db.conn.execute("SELECT COUNT(*) FROM mapping_index WHERE source='anibridge'").fetchone()[0] == n1

    r4 = up.update(["anibridge"])[0]
    assert r4.status == "updated"
    assert db.conn.execute("SELECT 1 FROM mapping_index WHERE dst_id='11111'").fetchone()

    r5 = up.rollback("anibridge")
    assert r5.status == "rolled_back"
    assert db.conn.execute("SELECT 1 FROM mapping_index WHERE dst_id='11111'").fetchone() is None
    assert db.get_override("anilist:21")["tmdb_id"] == 999  # los overrides sobreviven


def test_truncated_download_is_rejected(tmp_path, monkeypatch):
    monkeypatch.setitem(__import__("anime_catalog.mapping.index", fromlist=["x"]).DATASET_CLASSES, "anibridge", SmallAniBridge)
    transport, _ = _transport([(200, b'{"$meta": {"schema_version": "3.0.3"}, "anilist:1": {', {})])
    db = Database(tmp_path / "d.db")
    res = MappingUpdater(db, tmp_path / "ds", transport=transport, sleep=no_sleep).update(["anibridge"])[0]
    assert res.status == "failed"


def test_overrides_yaml_roundtrip(tmp_path):
    from anime_catalog.storage.overrides import export_overrides, import_overrides
    db = Database(tmp_path / "d.db")
    db.set_override("anilist:1", "map", "movie", 5, note="n")
    db.set_override("anilist:2", "canonical", canonical_uid="anilist:1")
    path = tmp_path / "o.yaml"
    assert export_overrides(db, path) == 2
    db2 = Database(tmp_path / "e.db")
    assert import_overrides(db2, path) == 2
    assert db2.get_override("anilist:2")["canonical_uid"] == "anilist:1"


def test_state_export_import(tmp_path):
    from anime_catalog.storage.state import export_state, import_state
    db = Database(tmp_path / "a.db")
    db.conn.execute("INSERT INTO managed_items(list_id, media_type, tmdb_id, catalog) VALUES(1,'tv',37854,'X')")
    db.set_override("anilist:1", "exclude")
    path = tmp_path / "state" / "state.json"
    assert export_state(db, path)["managed_items"] == 1
    db2 = Database(tmp_path / "b.db")
    import_state(db2, path)
    assert db2.conn.execute("SELECT tmdb_id FROM managed_items").fetchone()[0] == 37854
    assert db2.get_override("anilist:1")["action"] == "exclude"
