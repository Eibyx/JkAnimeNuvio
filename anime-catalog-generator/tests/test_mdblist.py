"""MDBListClient y SyncEngine contra un servidor MDBList simulado (nunca listas reales)."""

from __future__ import annotations

import pytest

from anime_catalog.config import MDBListConfig, SyncMode
from anime_catalog.integrations.mdblist import MDBListAuthError, MDBListClient, MDBListError
from anime_catalog.integrations.sync import SyncEngine, SyncError
from anime_catalog.models import MappingStatus, ResolvedTitle
from anime_catalog.storage.database import Database

from .conftest import FakeMDBList, no_sleep


def client(fake: FakeMDBList, key: str = "test-key") -> MDBListClient:
    return MDBListClient(key, "https://api.mdblist.test", transport=fake.transport(), sleep=no_sleep)


def title(mt: str, tid: int, name: str | None = None) -> ResolvedTitle:
    return ResolvedTitle(title=name or f"{mt}{tid}", canonical_uid=f"anilist:{tid}", media_type=mt, tmdb_id=tid,  # type: ignore[arg-type]
                         mapping_status=MappingStatus.CONFIRMED, confidence=1.0)


def engine(tmp_path, fake, run="r1", **cfg) -> tuple[SyncEngine, Database]:
    db = Database(tmp_path / "s.db")
    return SyncEngine(db, MDBListConfig(**cfg), client(fake), catalog="Test", run_id=run), db


def test_create_list_and_add_shows_and_movies(tmp_path, fake_mdblist):
    eng, _ = engine(tmp_path, fake_mdblist)
    plan = eng.plan("Anime 2020s", [title("tv", 37854), title("movie", 129)], dry_run=False)
    assert plan.will_create and plan.to_add == [("tv", 37854), ("movie", 129)]
    res = eng.apply(plan)
    assert res.created and res.list_id in fake_mdblist.lists
    assert sorted(fake_mdblist.items[res.list_id]) == [("movie", 129), ("tv", 37854)]
    posts = [c for c in fake_mdblist.write_calls() if c[1].endswith("/items/add")]
    assert {"shows": [{"tmdb": 37854}]} in [p for _, _, p in posts]
    assert {"movies": [{"tmdb": 129}]} in [p for _, _, p in posts]


def test_existing_list_reused_and_no_duplicates(tmp_path, fake_mdblist):
    lid = fake_mdblist.add_list("Anime 2020s", [("tv", 37854)])
    eng, _ = engine(tmp_path, fake_mdblist)
    plan = eng.plan("Anime 2020s", [title("tv", 37854), title("tv", 1429)], dry_run=False)
    assert plan.list_id == lid and plan.to_add == [("tv", 1429)] and plan.already_present == [("tv", 37854)]
    eng.apply(plan)
    assert fake_mdblist.items[lid].count(("tv", 37854)) == 1


def test_create_mode_refuses_existing_list_unless_reuse(tmp_path, fake_mdblist):
    fake_mdblist.add_list("X")
    eng, _ = engine(tmp_path, fake_mdblist, mode="create", reuse_existing=False)
    with pytest.raises(SyncError, match="ya existe"):
        eng.plan("X", [], dry_run=False)


def test_duplicate_list_names_are_not_chosen_arbitrarily(tmp_path, fake_mdblist):
    fake_mdblist.add_list("Dup")
    fake_mdblist.add_list("Dup")
    eng, _ = engine(tmp_path, fake_mdblist)
    with pytest.raises(SyncError, match="No se elige una al azar"):
        eng.plan("Dup", [], dry_run=False)


def test_list_id_option_disambiguates(tmp_path, fake_mdblist):
    fake_mdblist.add_list("Dup")
    lid = fake_mdblist.add_list("Dup")
    eng, _ = engine(tmp_path, fake_mdblist, list_id=lid)
    assert eng.plan("Dup", [], dry_run=False).list_id == lid


def test_append_never_removes(tmp_path, fake_mdblist):
    lid = fake_mdblist.add_list("L", [("tv", 1), ("tv", 2)])
    eng, _ = engine(tmp_path, fake_mdblist, mode="append")
    plan = eng.plan("L", [title("tv", 3)], dry_run=False)
    assert plan.to_remove == [] and set(plan.unmanaged_kept) == {("tv", 1), ("tv", 2)}
    eng.apply(plan)
    assert set(fake_mdblist.items[lid]) == {("tv", 1), ("tv", 2), ("tv", 3)}


def test_sync_removes_only_managed_items_with_permission(tmp_path, fake_mdblist):
    lid = fake_mdblist.add_list("L", [("tv", 100)])  # añadido a mano por el usuario
    eng, db = engine(tmp_path, fake_mdblist, mode="sync", run="r1")
    eng.apply(eng.plan("L", [title("tv", 1), title("tv", 2)], dry_run=False))
    # El catálogo cambia: tv:2 ya no cumple.
    eng2 = SyncEngine(db, MDBListConfig(mode=SyncMode.SYNC), client(fake_mdblist), catalog="Test", run_id="r2")
    plan = eng2.plan("L", [title("tv", 1)], dry_run=False)
    assert plan.to_remove == []  # sin allow_removals no se borra nada
    eng3 = SyncEngine(db, MDBListConfig(mode=SyncMode.SYNC, allow_removals=True), client(fake_mdblist), catalog="Test", run_id="r3")
    plan = eng3.plan("L", [title("tv", 1)], dry_run=False)
    assert plan.to_remove == [("tv", 2)]
    assert ("tv", 100) in plan.unmanaged_kept
    eng3.apply(plan)
    assert set(fake_mdblist.items[lid]) == {("tv", 1), ("tv", 100)}


def test_replace_requires_confirmation(tmp_path, fake_mdblist):
    lid = fake_mdblist.add_list("L", [("tv", 100)])
    eng, _ = engine(tmp_path, fake_mdblist, mode="replace")
    plan = eng.plan("L", [title("tv", 1)], dry_run=False)
    assert plan.to_remove == [("tv", 100)]
    with pytest.raises(SyncError, match="confirm-replace"):
        eng.apply(plan)
    assert ("tv", 100) in fake_mdblist.items[lid]
    eng.apply(plan, confirm_replace=True)
    assert fake_mdblist.items[lid] == [("tv", 1)]


def test_dry_run_plan_makes_no_writes(tmp_path, fake_mdblist):
    eng, _ = engine(tmp_path, fake_mdblist)
    plan = eng.plan("Nueva", [title("tv", 1)], dry_run=True)
    assert plan.will_create
    assert fake_mdblist.write_calls() == [] and fake_mdblist.lists == {}


def test_auth_error(fake_mdblist):
    with pytest.raises(MDBListAuthError):
        client(fake_mdblist, key="wrong").lists()


def test_http_429_retries_after_retry_after(fake_mdblist):
    fake_mdblist.rate_limit_once = True
    waits: list[float] = []
    c = MDBListClient("test-key", "https://api.mdblist.test", transport=fake_mdblist.transport(), sleep=waits.append)
    assert c.lists() == []
    assert any(w >= 1.0 for w in waits)


def test_daily_limit_is_not_retried(fake_mdblist):
    lid = fake_mdblist.add_list("L")
    fake_mdblist.fail_writes_after = 0
    with pytest.raises(MDBListError, match="diario"):
        client(fake_mdblist).modify(lid, "add", [("tv", 1)])
    assert len(fake_mdblist.write_calls()) == 1


def test_partial_response_is_reported(tmp_path, fake_mdblist):
    fake_mdblist.add_list("L")
    fake_mdblist.partial_response = True
    eng, _ = engine(tmp_path, fake_mdblist)
    res = eng.apply(eng.plan("L", [title("tv", 1), title("tv", 2)], dry_run=False))
    assert any("parcial" in e for e in res.errors)


def test_not_found_items_are_recorded(tmp_path, fake_mdblist):
    fake_mdblist.add_list("L")
    fake_mdblist.unknown_tmdb = {("tv", 2)}
    eng, _ = engine(tmp_path, fake_mdblist)
    res = eng.apply(eng.plan("L", [title("tv", 1), title("tv", 2)], dry_run=False))
    assert res.added == [("tv", 1)]
    assert res.not_found == [("tv", 2)]
    managed = {tuple(r) for r in eng.db.conn.execute("SELECT media_type, tmdb_id FROM managed_items")}
    assert managed == {("tv", 1)}


def test_interruption_and_resume_without_duplicates(tmp_path, fake_mdblist):
    lid = fake_mdblist.add_list("L")
    fake_mdblist.fail_writes_after = 2  # tras el primer lote (2 elementos) se agota la cuota diaria
    titles = [title("tv", i) for i in range(1, 7)]
    eng, db = engine(tmp_path, fake_mdblist, batch_size=2, run="r1")
    res = eng.apply(eng.plan("L", titles, dry_run=False))
    assert res.interrupted and len(fake_mdblist.items[lid]) == 2
    assert len(res.failed) == 4
    # Reanudación al día siguiente: se vuelve a calcular la diferencia.
    fake_mdblist.fail_writes_after = None
    eng2 = SyncEngine(db, MDBListConfig(batch_size=2), client(fake_mdblist), catalog="Test", run_id="r2")
    plan = eng2.plan("L", titles, dry_run=False)
    assert len(plan.to_add) == 4
    eng2.apply(plan)
    assert sorted(fake_mdblist.items[lid]) == sorted(("tv", i) for i in range(1, 7))
    assert len(fake_mdblist.items[lid]) == len(set(fake_mdblist.items[lid]))


def test_batches_and_pagination(tmp_path, fake_mdblist):
    lid = fake_mdblist.add_list("L", [("tv", i) for i in range(1, 251)])
    fake_mdblist.page_size_override = 100
    items = client(fake_mdblist).list_items(lid)
    assert len(items) == 250
    eng, _ = engine(tmp_path, fake_mdblist, batch_size=100)
    plan = eng.plan("L", [title("tv", i) for i in range(1, 501)], dry_run=False)
    assert len(plan.to_add) == 250
    eng.apply(plan)
    adds = [c for c in fake_mdblist.write_calls() if c[1].endswith("/add")]
    assert len(adds) == 3 and len(fake_mdblist.items[lid]) == 500
