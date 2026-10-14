"""Pruebas OPCIONALES de solo lectura contra las APIs y datasets reales.

Se ejecutan solo con ANIME_CATALOG_LIVE_TESTS=1 (p. ej. `ANIME_CATALOG_LIVE_TESTS=1 pytest -m live`).
Nunca escriben en MDBList.
"""

from __future__ import annotations

import os

import pytest

from anime_catalog.config import MappingConfig, Settings
from anime_catalog.context import build_context
from anime_catalog.mapping.resolver import MappingResolver

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(os.environ.get("ANIME_CATALOG_LIVE_TESTS") != "1", reason="pruebas reales desactivadas"),
]


@pytest.fixture
def live_ctx(tmp_path):
    s = Settings.from_env(env_file=None)
    s = s.model_copy(update={"database_path": tmp_path / "live.db", "datasets_dir": tmp_path / "ds", "mdblist_api_key": None})
    ctx = build_context(s)
    yield ctx
    ctx.close()


def test_live_one_piece_mapping(live_ctx):
    res = live_ctx.updater.update(["anibridge"])
    assert res[0].status == "updated"
    entry = live_ctx.anilist.get(21)
    assert entry is not None and entry.mal_id == 21
    r = MappingResolver(live_ctx.db, live_ctx.index, MappingConfig(), live_ctx.tmdb).resolve_entry(entry)
    assert (r.media_type, r.tmdb_id) == ("tv", 37854)


def test_live_mdblist_read_only(live_ctx):
    key = os.environ.get("MDBLIST_API_KEY")
    if not key:
        pytest.skip("sin MDBLIST_API_KEY")
    from anime_catalog.integrations.mdblist import MDBListClient
    c = MDBListClient(key)
    assert isinstance(c.lists(), list)
