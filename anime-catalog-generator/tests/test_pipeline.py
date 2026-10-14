"""Pruebas de extremo a extremo con AniList y MDBList simulados (criterios de aceptación B–G)."""

from __future__ import annotations

import copy
import json
from datetime import date

from typer.testing import CliRunner

from anime_catalog import cli
from anime_catalog.catalog.pipeline import CatalogPipeline
from anime_catalog.config import parse_config
from anime_catalog.context import Transports
from anime_catalog.reporting.reports import write_reports

from .conftest import load_fixture_index, no_sleep

TODAY = date(2026, 10, 14)


def run(ctx, cfg_dict, *, dry_run=True, **kw):
    cfg = parse_config(cfg_dict)
    rep = CatalogPipeline(ctx, cfg, dry_run=dry_run, offline=True, today=TODAY, **kw).run()
    return cfg, rep


def ids(rep):
    return {t.identity for t in rep.addable}


def base(**filters):
    return {"catalog": {"name": "Anime 2020-2026"}, "filters": {"start_year": 2020, "end_year": 2026, "formats": ["TV"], **filters}}


def test_2020s_original_series_without_duplicate_seasons(make_context):
    """Prueba B/D: todas las páginas, series canónicas, sin temporadas duplicadas, sin escribir."""
    ctx = make_context()
    cfg, rep = run(ctx, base())
    assert ids(rep) == {("tv", 95479)}  # solo JJK empezó en 2020-2026; AoT (2013) y Demon Slayer (2019) no
    jjk = rep.addable[0]
    assert jjk.canonical_uid == "anilist:113415"
    assert {"anilist:145064", "anilist:172463"} <= set(jjk.members)
    excluded = {e.uid: e for e in rep.excluded}
    assert "anilist:16498" in excluded and "2013" in excluded["anilist:16498"].reasons[0]
    assert rep.plan is not None and rep.plan.will_create
    assert rep.sync is None


def test_temporal_modes_produce_different_results(make_context):
    ctx = make_context()
    score = {"min": 83}
    _, original = run(ctx, base(score=score))
    _, any_season = run(ctx, base(score=score, temporal_mode="any_season_release_year"))
    _, entry_mode = run(ctx, base(score=score, temporal_mode="entry_release_year"))
    assert ids(original) == {("tv", 95479)}
    assert ids(any_season) == {("tv", 95479), ("tv", 1429)}  # AoT: Final Season en rango y la serie original tiene 85
    # Demon Slayer original tiene 82 (< 83), pero su temporada Yuukaku-hen (86, 2021) cumple como entrada.
    assert ids(entry_mode) == {("tv", 95479), ("tv", 1429), ("tv", 85937)}


def test_any_member_metadata_scope(make_context):
    ctx = make_context()
    _, rep = run(ctx, base(score={"min": 83}, temporal_mode="any_season_release_year", metadata_scope="any_member"))
    assert ("tv", 85937) in ids(rep)


def test_movies_catalog_maps_to_movie_ids(make_context):
    """Prueba C: las películas se mapean a TMDB Movie y no a series."""
    ctx = make_context()
    _, rep = run(ctx, {"catalog": {"name": "Anime Movies"}, "filters": {"start_year": 1990, "end_year": 2026, "formats": ["MOVIE"],
                                                                         "exclude_compilations": True}})
    got = ids(rep)
    assert ("movie", 129) in got and ("movie", 635302) in got  # Chihiro, Mugen Train
    assert all(t[0] == "movie" for t in got)
    assert "anilist:119113" in {e.uid for e in rep.excluded}  # Chronicle: recopilatorio


def test_apply_creates_list_rerun_adds_nothing_and_append_adds_only_new(make_context, fake_mdblist, fake_anilist, raw_media):
    """Pruebas E, F y G con MDBList simulado."""
    ctx = make_context()
    cfg_dict = base(temporal_mode="any_season_release_year")
    _, rep1 = run(ctx, cfg_dict, dry_run=False)
    lid = rep1.sync.list_id
    assert rep1.sync.created and set(fake_mdblist.items[lid]) == ids(rep1)
    first_writes = len(fake_mdblist.write_calls())

    _, rep2 = run(ctx, cfg_dict, dry_run=False)  # F: mismo comando
    assert rep2.plan.to_add == [] and len(fake_mdblist.write_calls()) == first_writes
    assert len(fake_mdblist.items[lid]) == len(set(fake_mdblist.items[lid]))

    # G: aparece un anime nuevo (con su mapping) y se ejecuta append.
    new = copy.deepcopy(raw_media[113415])
    new.update({"id": 990001, "idMal": 990001, "title": {"romaji": "Nuevo Anime", "english": "New Anime", "native": "新"},
                "startDate": {"year": 2025, "month": 4, "day": 1}, "relations": {"edges": []}})
    fake_anilist.media[990001] = new
    ctx.db.conn.execute("INSERT INTO mapping_index(source, src_provider, src_id, src_scope, dst_provider, dst_id, dst_scope, detail) "
                        "VALUES('anibridge','anilist','990001',NULL,'tmdb_show','424242','s1','eps=12;1-12>1-12')")
    ctx.cache.invalidate("anilist_query")
    _, rep3 = run(ctx, cfg_dict, dry_run=False)
    assert rep3.plan.to_add == [("tv", 424242)]
    assert rep3.sync.added == [("tv", 424242)]
    assert fake_mdblist.items[lid].count(("tv", 424242)) == 1


def test_dry_run_with_existing_list_never_writes(make_context, fake_mdblist):
    fake_mdblist.add_list("Anime 2020-2026", [("tv", 95479)])
    ctx = make_context()
    _, rep = run(ctx, base())
    assert rep.plan.already_present == [("tv", 95479)] and rep.plan.to_add == []
    assert fake_mdblist.write_calls() == []


def test_reports_are_written(make_context, tmp_path):
    ctx = make_context()
    cfg, rep = run(ctx, base(temporal_mode="any_season_release_year"))
    out = write_reports(rep, cfg, tmp_path / "rep")
    for name in ("summary.json", "titles.csv", "review.csv", "excluded.csv", "duplicates.csv", "to_add.csv", "report.html", "summary.csv"):
        assert (out / name).exists(), name
    data = json.loads((out / "summary.json").read_text(encoding="utf-8"))
    assert data["stats"]["valid_titles"] == len(rep.addable)
    assert data["dataset_versions"]["anibridge"] == "fixture-anibridge"
    assert any(d["kind"] == "season_group" for d in data["duplicates"])


def test_limit_and_sort(make_context):
    ctx = make_context()
    _, rep = run(ctx, base(temporal_mode="any_season_release_year", sort="score", order="desc", limit=1))
    assert len(rep.addable) == 1
    assert any(e.stage == "limit" for e in rep.excluded)


def test_studio_query_without_dates(make_context):
    ctx = make_context()
    _, rep = run(ctx, {"catalog": {"name": "MAPPA"}, "filters": {"formats": ["TV"], "studios": {"include": ["MAPPA"], "main_only": True}}})
    assert ids(rep) == {("tv", 95479)}  # JJK (MAPPA); AoT Final Season es MAPPA pero la serie original es de Wit


def test_cli_dry_run_and_mapping(tmp_path, monkeypatch, fake_anilist, fake_mdblist):
    db_path = tmp_path / "cli.db"
    from anime_catalog.storage.database import Database
    db = Database(db_path)
    load_fixture_index(db, tmp_path / "datasets")
    db.close()
    monkeypatch.setenv("DATABASE_PATH", str(db_path))
    monkeypatch.setenv("REPORTS_DIR", str(tmp_path / "reports"))
    monkeypatch.setenv("OVERRIDES_PATH", str(tmp_path / "overrides.yaml"))
    monkeypatch.setenv("MDBLIST_API_KEY", "test-key")
    monkeypatch.setenv("MDBLIST_API_URL", "https://api.mdblist.test")
    monkeypatch.delenv("TMDB_API_KEY", raising=False)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(cli, "TRANSPORTS", Transports(anilist=fake_anilist.transport(), mdblist=fake_mdblist.transport(), sleep=no_sleep))
    runner = CliRunner()
    res = runner.invoke(cli.app, ["create", "--from", "2020", "--to", "2026", "--first-only", "--format", "TV",
                                  "--name", "Anime 2020-2026", "--dry-run", "--offline"])
    assert res.exit_code == 0, res.output
    assert "ANIME CATALOG GENERATOR" in res.output and "JUJUTSU KAISEN" in res.output
    assert fake_mdblist.write_calls() == []
    res = runner.invoke(cli.app, ["mapping", "--anilist-id", "21", "--offline"])
    assert res.exit_code == 0, res.output
    assert "37854" in res.output and "anibridge" in res.output
    res = runner.invoke(cli.app, ["create", "--name", "X", "--apply", "--dry-run", "--offline"])
    assert res.exit_code == 2
    res = runner.invoke(cli.app, ["review", "set", "anilist:999", "--exclude", "--note", "prueba"])
    assert res.exit_code == 0 and (tmp_path / "overrides.yaml").exists()
