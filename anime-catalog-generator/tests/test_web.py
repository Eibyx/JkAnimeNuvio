"""API local, seguridad, trabajos con progreso (SSE), cancelación, explorador y MDBList visual.

Usa AniList y MDBList simulados (conftest): ninguna prueba escribe en MDBList real.
"""

from __future__ import annotations

import json
import os
import re
import stat
import threading
import time

import pytest
from fastapi.testclient import TestClient

from anime_catalog.catalog.progress import Cancelled, Progress
from anime_catalog.config import MDBListConfig, Settings
from anime_catalog.context import Transports
from anime_catalog.integrations.mdblist import MDBListClient
from anime_catalog.integrations.sync import SyncEngine
from anime_catalog.models import MappingStatus, ResolvedTitle
from anime_catalog.storage.database import Database
from anime_catalog.web.jobs import Job, JobConflict, JobManager
from anime_catalog.web.security import SecurityConfig
from anime_catalog.web.server import create_app

from .conftest import FIXTURES, load_fixture_index, no_sleep

BASE = "http://127.0.0.1:8765"


@pytest.fixture
def make_app(tmp_path, fake_anilist, fake_mdblist, monkeypatch):
    for k in ("MDBLIST_API_KEY", "TMDB_API_KEY", "TMDB_READ_ACCESS_TOKEN", "TVDB_API_KEY", "TVDB_SUBSCRIBER_PIN"):
        monkeypatch.delenv(k, raising=False)
    created = []

    def factory(*, mdblist_key: str | None = "test-key", security: SecurityConfig | None = None):
        if mdblist_key:
            monkeypatch.setenv("MDBLIST_API_KEY", mdblist_key)
        settings = Settings(
            mdblist_api_key=mdblist_key, database_path=tmp_path / "web.db", datasets_dir=tmp_path / "ds",
            reports_dir=tmp_path / "reports", overrides_path=tmp_path / "overrides.yaml", profiles_dir=tmp_path / "profiles",
            env_file=tmp_path / ".env", mdblist_api_url="https://api.mdblist.test",
        )
        db = Database(settings.database_path)
        if not db.conn.execute("SELECT 1 FROM mapping_index LIMIT 1").fetchone():
            load_fixture_index(db, tmp_path / "ds")
        db.close()
        transports = Transports(anilist=fake_anilist.transport(), mdblist=fake_mdblist.transport(), sleep=no_sleep)
        sec = security or SecurityConfig()
        app = create_app(settings, security=sec, transports=transports)
        client = TestClient(app, base_url=BASE)
        client.headers["X-CSRF-Token"] = sec.csrf_token
        created.append(app)
        return client, app

    yield factory
    for app in created:
        app.state.jobs.shutdown()


def wait_job(client: TestClient, job_id: str, timeout: float = 30) -> dict:
    end = time.time() + timeout
    while time.time() < end:
        snap = client.get(f"/api/jobs/{job_id}").json()
        if snap["status"] not in ("queued", "running"):
            return snap
        time.sleep(0.05)
    raise AssertionError("el trabajo no terminó")


CFG = {"catalog": {"name": "Anime 2020-2026"}, "filters": {"start_year": 2020, "end_year": 2026, "formats": ["TV"],
                                                            "temporal_mode": "any_season_release_year"}}


# ---------------------------------------------------------------------- interfaz y seguridad


def test_index_static_and_security_headers(make_app):
    client, app = make_app()
    r = client.get("/")
    assert r.status_code == 200
    token = re.search(r'name="csrf-token" content="([^"]+)"', r.text).group(1)
    assert token == app.state.security.csrf_token
    assert "default-src 'self'" in r.headers["content-security-policy"]
    assert r.headers["x-frame-options"] == "DENY"
    for asset in ("/static/app.js", "/static/app.css", "/static/icon.svg", "/manifest.webmanifest"):
        assert client.get(asset).status_code == 200
    js = client.get("/static/app.js").text
    html = r.text
    # Sin CDN ni recursos externos para renderizar la interfaz.
    assert not re.search(r'<(script|link)[^>]+(src|href)="https?://', html)
    assert "import(" not in js and "fetch('http" not in js


def test_host_origin_and_csrf_protection(make_app):
    client, _ = make_app()
    assert client.get("/api/status", headers={"Host": "evil.example"}).status_code == 421
    assert client.post("/api/config/validate", json={"config": CFG}, headers={"Origin": "https://evil.example"}).status_code == 403
    no_token = TestClient(client.app, base_url=BASE)
    assert no_token.post("/api/config/validate", json={"config": CFG}).status_code == 403
    assert no_token.post("/api/config/validate", json={"config": CFG}, headers={"X-CSRF-Token": "falso"}).status_code == 403
    assert client.post("/api/config/validate", json={"config": CFG}).status_code == 200


def test_remote_access_requires_token(make_app):
    sec = SecurityConfig(host="192.168.1.20", port=8765, allow_remote=True, access_token="secreto-largo")
    client, _ = make_app(security=sec)
    remote = TestClient(client.app, base_url="http://192.168.1.20:8765")
    assert remote.get("/api/status").status_code == 401
    assert remote.get("/api/status", headers={"Authorization": "Bearer secreto-largo"}).status_code == 200


def test_keys_are_saved_but_never_returned(make_app, tmp_path):
    client, _ = make_app(mdblist_key=None)
    r = client.post("/api/settings/keys", json={"MDBLIST_API_KEY": "mdb-SECRETO-123", "TMDB_API_KEY": "tmdb-SECRETO-456"})
    assert r.status_code == 200
    body = json.dumps(r.json()) + client.get("/api/settings").text + client.get("/api/status").text + client.get("/api/dashboard").text
    assert "SECRETO" not in body
    assert client.get("/api/settings").json()["keys"]["MDBLIST_API_KEY"] is True
    env = tmp_path / ".env"
    assert "mdb-SECRETO-123" in env.read_text()
    if os.name == "posix":
        assert stat.S_IMODE(env.stat().st_mode) == 0o600
    assert client.post("/api/settings/keys", json={"OTRA": "x"}).status_code == 400
    client.post("/api/settings/keys", json={"TMDB_API_KEY": ""})
    assert "tmdb-SECRETO-456" not in env.read_text()
    os.environ.pop("MDBLIST_API_KEY", None)


# ---------------------------------------------------------------------- configuración y perfiles


def test_options_validation_and_expression(make_app):
    client, _ = make_app()
    opts = client.get("/api/options").json()
    assert "TV" in opts["formats"] and opts["genres"]  # sin red de AniList: lista básica de géneros
    assert opts["defaults"]["filters"]["formats"] == ["TV", "MOVIE"]
    bad = client.post("/api/config/validate", json={"config": {"catalog": {"name": "x"}, "filters": {"start_year": 2026, "end_year": 2020}}})
    assert bad.status_code == 422 and "start_year" in bad.json()["detail"]
    ok = client.post("/api/config/validate", json={"config": CFG, "expression_yaml": "and:\n  - not: {genres: {include: [Horror]}}\n  - or:\n    - genres: {include: [Action]}\n    - tags: {include: [Magic], min_rank: 50}\n"})
    assert ok.status_code == 200
    assert ok.json()["config"]["filters"]["expression"]["and"][0]["not"]["genres"]["include"] == ["Horror"]
    assert "expression:" in ok.json()["yaml"]
    assert client.post("/api/config/validate", json={"config": CFG, "expression_yaml": "- a\n- b"}).status_code == 422
    imp = client.post("/api/config/from-yaml", json={"yaml": "catalog: {name: Desde YAML}\nfilters: {decades: ['2010s']}\n"})
    assert imp.json()["config"]["filters"]["decades"] == [2010]


def test_profiles_crud(make_app):
    client, _ = make_app()
    assert client.put("/api/profiles/mi-perfil", json={"config": CFG}).status_code == 200
    lst = client.get("/api/profiles").json()
    assert lst[0]["name"] == "mi-perfil" and lst[0]["valid"] and lst[0]["catalog"] == "Anime 2020-2026"
    loaded = client.get("/api/profiles/mi-perfil").json()
    assert loaded["config"]["filters"]["start_year"] == 2020 and "start_year: 2020" in loaded["yaml"]
    assert client.put("/api/profiles/../escape", json={"config": CFG}).status_code in (400, 404)
    assert client.put("/api/profiles/x", json={"config": {"catalog": {"name": ""}}}).status_code == 422
    assert client.delete("/api/profiles/mi-perfil").json()["deleted"] is True


# ---------------------------------------------------------------------- trabajos y progreso


def test_dry_run_job_with_sse_progress_and_paginated_results(make_app, fake_mdblist):
    client, _ = make_app()
    job = client.post("/api/jobs/catalog", json={"config": CFG}).json()
    events = []
    with client.stream("GET", f"/api/jobs/{job['id']}/events") as resp:
        assert resp.headers["content-type"].startswith("text/event-stream")
        for line in resp.iter_lines():
            if line.startswith("data: ") and line != "data: {}":
                events.append(json.loads(line[6:]))
            if line.startswith("event: end"):
                break
    assert events and events[-1]["status"] == "done"
    phases = {p["name"] for e in events for p in e["phases"]}
    assert any("Resolviendo mappings" in p for p in phases)
    # Porcentaje solo con total conocido.
    for e in events:
        if e["total"] is None:
            assert e["percent"] is None
    final = client.get(f"/api/jobs/{job['id']}").json()
    res = final["result"]
    assert res["dry_run"] is True and res["stats"]["valid_titles"] == 3
    assert fake_mdblist.write_calls() == []
    page = client.get(f"/api/jobs/{job['id']}/rows?section=titles&page=1&size=2").json()
    assert page["total"] == 3 and len(page["items"]) == 2 and page["pages"] == 2
    found = client.get(f"/api/jobs/{job['id']}/rows?section=titles&q=jujutsu").json()
    assert found["total"] == 1
    assert client.get(f"/api/jobs/{job['id']}/rows?section=excluded").json()["total"] >= 1


def test_writes_require_confirmation_and_key(make_app):
    client, _ = make_app()
    assert client.post("/api/jobs/catalog", json={"config": CFG, "apply": True}).status_code == 428
    rep = {**CFG, "mdblist": {"mode": "replace"}}
    assert client.post("/api/jobs/catalog", json={"config": rep, "apply": True, "confirm": True}).status_code == 428
    client2, _ = make_app(mdblist_key=None)
    os.environ.pop("MDBLIST_API_KEY", None)
    client2.app.state.services.settings = client2.app.state.services.settings.model_copy(update={"mdblist_api_key": None})
    assert client2.post("/api/jobs/catalog", json={"config": CFG, "apply": True, "confirm": True}).status_code == 412


def test_visual_sync_creates_list_without_duplicates_and_history(make_app, fake_mdblist):
    client, _ = make_app()
    first = wait_job(client, client.post("/api/jobs/catalog", json={"config": CFG, "apply": True, "confirm": True}).json()["id"])
    assert first["status"] == "done", first["errors"]
    lid = first["result"]["list"]["id"]
    assert first["result"]["list"]["created"] and first["result"]["sync"]["added"] == 3
    second = wait_job(client, client.post("/api/jobs/catalog", json={"config": CFG, "apply": True, "confirm": True}).json()["id"])
    assert second["result"]["list"]["to_add"] == 0
    assert len(fake_mdblist.items[lid]) == len(set(fake_mdblist.items[lid])) == 3
    lists = client.get("/api/mdblist/lists").json()
    assert lists[0]["managed"] == 3
    items = client.get(f"/api/mdblist/lists/{lid}/items?size=2").json()
    assert items["total"] == 3 and all(i["managed"] for i in items["items"])
    runs = client.get("/api/runs").json()
    assert runs["total"] >= 2
    run_id = first["result"]["run_id"]
    ops = client.get(f"/api/runs/{run_id}/items").json()
    assert {o["status"] for o in ops} == {"done"}
    dash = client.get("/api/dashboard").json()
    assert dash["last_sync"] and dash["series"] >= 3


def test_items_not_added_are_reported(make_app, fake_mdblist):
    client, _ = make_app()
    fake_mdblist.unknown_tmdb = {("tv", 95479)}
    snap = wait_job(client, client.post("/api/jobs/catalog", json={"config": CFG, "apply": True, "confirm": True}).json()["id"])
    assert ["tv", 95479] in snap["result"]["sync"]["not_found"]
    assert any("95479" in e for e in snap["errors"])


def test_mdblist_create_requires_confirm(make_app, fake_mdblist):
    client, _ = make_app()
    assert client.post("/api/mdblist/lists", json={"name": "Nueva"}).status_code == 428
    r = client.post("/api/mdblist/lists", json={"name": "Nueva", "confirm": True})
    assert r.status_code == 200 and r.json()["id"] in fake_mdblist.lists
    assert client.post("/api/mdblist/lists", json={"name": "Nueva", "confirm": True}).status_code == 409


def test_mdblist_routes_without_key(make_app):
    client, app = make_app(mdblist_key=None)
    os.environ.pop("MDBLIST_API_KEY", None)
    app.state.services.settings = app.state.services.settings.model_copy(update={"mdblist_api_key": None})
    assert client.get("/api/mdblist/lists").status_code == 412


# ---------------------------------------------------------------------- cancelación y bloqueos


def test_job_manager_cancel_lock_and_recovery(tmp_path):
    mgr = JobManager(str(tmp_path / "jobs.db"), max_workers=2)
    started = threading.Event()

    def slow(job: Job, progress: Progress) -> dict:
        progress.phase("Trabajo largo", 1000)
        started.set()
        for i in range(1000):
            progress.check()
            progress.advance(1)
            time.sleep(0.005)
        return {"ok": True}

    j1 = mgr.submit("catalog", "Lento", {}, slow, list_key="name:lista")
    started.wait(5)
    with pytest.raises(JobConflict):
        mgr.submit("catalog", "Otro", {}, slow, list_key="name:lista")
    snap = j1.snapshot()
    assert snap["total"] == 1000 and snap["percent"] is not None
    mgr.cancel(j1.id)
    for _ in range(200):
        if j1.status not in ("queued", "running"):
            break
        time.sleep(0.02)
    assert j1.status == "cancelled" and j1.processed < 1000
    # Una vez cancelado, la lista vuelve a estar libre.
    j2 = mgr.submit("catalog", "Rápido", {}, lambda j, p: {"ok": True}, list_key="name:lista")
    for _ in range(100):
        if j2.status == "done":
            break
        time.sleep(0.02)
    assert j2.status == "done"
    # Un trabajo que estaba en marcha cuando murió el proceso aparece como interrumpido.
    db = Database(tmp_path / "jobs.db")
    db.conn.execute("INSERT INTO jobs(job_id, kind, title, status, params, snapshot, created_at, updated_at) VALUES('zzz','catalog','X','running','{}','{}',1,1)")
    db.close()
    mgr.shutdown()
    mgr2 = JobManager(str(tmp_path / "jobs.db"))
    assert mgr2.get("zzz").status == "interrupted"
    assert mgr2.get(j1.id).status == "cancelled"
    mgr2.shutdown()


def test_unknown_total_has_no_percent():
    job = Job(id="x", kind="catalog", title="t", params={})
    job.processed, job.total, job.started_at = 50, None, time.time()
    assert job.snapshot()["percent"] is None
    job.total = 200
    assert job.snapshot()["percent"] == 25.0


class CancelAfter(Progress):
    def __init__(self, n: int):
        self.n = n
        self.checks = 0

    def check(self) -> None:
        self.checks += 1
        if self.checks > self.n:
            raise Cancelled()


def test_sync_cancel_between_batches_then_resume(tmp_path, fake_mdblist):
    lid = fake_mdblist.add_list("L")
    client = MDBListClient("test-key", "https://api.mdblist.test", transport=fake_mdblist.transport(), sleep=no_sleep)
    db = Database(tmp_path / "s.db")
    titles = [ResolvedTitle(title=f"t{i}", canonical_uid=f"anilist:{i}", media_type="tv", tmdb_id=i,
                            mapping_status=MappingStatus.CONFIRMED, confidence=1) for i in range(1, 7)]
    eng = SyncEngine(db, MDBListConfig(batch_size=2), client, catalog="L", run_id="r1")
    res = eng.apply(eng.plan("L", titles, dry_run=False), progress=CancelAfter(1))
    assert res.cancelled and len(fake_mdblist.items[lid]) == 2 and len(res.failed) == 4
    eng2 = SyncEngine(db, MDBListConfig(batch_size=2), client, catalog="L", run_id="r2")
    eng2.apply(eng2.plan("L", titles, dry_run=False))
    assert sorted(fake_mdblist.items[lid]) == [("tv", i) for i in range(1, 7)]


def test_api_cancel_endpoint(make_app, fake_anilist):
    client, app = make_app()
    gate = threading.Event()
    original = fake_anilist.handler

    def slow_handler(request):  # AniList lento: da tiempo a cancelar
        gate.wait(5)
        return original(request)

    fake_anilist.handler = slow_handler
    app.state.services.transports = Transports(anilist=__import__("httpx").MockTransport(slow_handler),
                                               mdblist=app.state.services.transports.mdblist, sleep=no_sleep)
    job = client.post("/api/jobs/catalog", json={"config": CFG}).json()
    assert client.post(f"/api/jobs/{job['id']}/cancel").json()["cancel_requested"] is True
    gate.set()
    snap = wait_job(client, job["id"])
    assert snap["status"] == "cancelled"
    retry = client.post(f"/api/jobs/{job['id']}/retry").json()
    assert wait_job(client, retry["id"])["status"] == "done"


# ---------------------------------------------------------------------- explorador de mappings


def test_mapping_explorer_search_by_every_id(make_app):
    client, _ = make_app()
    by_tmdb = client.get("/api/mappings/search?by=tmdb&q=37854").json()
    assert by_tmdb["items"][0]["uid"] == "anilist:21" and by_tmdb["items"][0]["source"] == "anibridge"
    by_mal = client.get("/api/mappings/search?by=mal&q=40748").json()
    assert by_mal["items"][0]["uid"] == "anilist:113415"
    by_anidb = client.get("/api/mappings/search?by=anidb&q=69").json()
    assert "anilist:21" in {i["uid"] for i in by_anidb["items"]}
    by_tvdb = client.get("/api/mappings/search?by=tvdb&q=267440").json()
    assert "anilist:16498" in {i["uid"] for i in by_tvdb["items"]}
    by_imdb = client.get("/api/mappings/search?by=imdb&q=tt0388629").json()
    assert "anilist:21" in {i["uid"] for i in by_imdb["items"]}
    by_id = client.get("/api/mappings/search?by=anilist&q=16498").json()
    assert by_id["items"][0]["tmdb_id"] == 1429
    client.get("/api/mappings/detail?uid=anilist:21")  # carga One Piece en la base local
    by_title = client.get("/api/mappings/search?by=title&q=one%20piece&remote=false").json()
    assert "anilist:21" in {i["uid"] for i in by_title["items"]}
    assert client.get("/api/mappings/search?by=imdb&q=123").status_code == 400
    assert client.get("/api/mappings/search?by=tmdb&q=999999999").json()["note"]


def test_mapping_detail_canonical_and_override(make_app):
    client, _ = make_app()
    d = client.get("/api/mappings/detail?uid=anilist:145064").json()
    assert d["canonical"]["uid"] == "anilist:113415"
    assert d["mapping"]["tmdb_id"] == 95479 and d["mapping"]["status"] == "high_confidence"
    assert d["entry_mapping"]["seasons"] == [1, 2]  # AniBridge: episodios 25-47 de s1 y s2
    assert any(c["source"] == "anibridge" for c in d["candidates"])
    r = client.post("/api/overrides", json={"uid": "anilist:145064", "action": "map", "media_type": "tv", "tmdb_id": 999, "note": "prueba"})
    assert r.status_code == 200
    d2 = client.get("/api/mappings/detail?uid=anilist:145064").json()
    assert d2["override"]["tmdb_id"] == 999 and d2["entry_mapping"]["tmdb_id"] == 999
    assert client.delete("/api/overrides/anilist:145064").json()["deleted"] is True
    assert client.post("/api/overrides", json={"uid": "nope", "action": "exclude"}).status_code == 400
    assert client.get("/api/mappings/detail?uid=../../etc").status_code == 400


def test_review_queue_endpoint(make_app):
    client, _ = make_app()
    cfg = {"catalog": {"name": "Pelis"}, "filters": {"start_year": 1990, "end_year": 2026, "formats": ["MUSIC"]}}
    wait_job(client, client.post("/api/jobs/catalog", json={"config": cfg}).json()["id"])
    rev = client.get("/api/review").json()
    assert rev["total"] >= 1 and rev["items"][0]["status"] in ("conflict", "needs_review", "unmapped")


def test_datasets_job(make_app, monkeypatch):
    client, app = make_app()
    import httpx

    payload = (FIXTURES / "kometa_anime_ids.json").read_bytes()
    app.state.services.transports = Transports(
        anilist=app.state.services.transports.anilist, mdblist=app.state.services.transports.mdblist,
        datasets=httpx.MockTransport(lambda r: httpx.Response(200, content=payload, headers={"ETag": '"x"'})), sleep=no_sleep)
    snap = wait_job(client, client.post("/api/jobs/datasets", json={"sources": ["kometa"]}).json()["id"])
    assert snap["status"] == "done"
    # Las filas del fixture están por debajo del mínimo de un dataset real: se rechaza y se conserva el índice.
    assert snap["result"]["datasets"][0]["status"] == "failed"
