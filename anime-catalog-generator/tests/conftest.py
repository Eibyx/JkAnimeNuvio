"""Infraestructura de pruebas: servidores simulados (AniList, MDBList, TMDB) y datos reales recortados.

Los fixtures de `tests/fixtures/` se generaron con `scripts/build_test_fixtures.py` a partir de las
respuestas reales de AniList y de los datasets publicados de AniBridge, Kometa y Fribb (2026-10-14).
Ninguna prueba accede a la red ni modifica listas reales de MDBList.
"""

from __future__ import annotations

import copy
import json
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest

from anime_catalog.config import Settings
from anime_catalog.context import AppContext, Transports, build_context
from anime_catalog.mapping.anibridge import AniBridgeDataset
from anime_catalog.mapping.fribb import FribbDataset
from anime_catalog.mapping.kometa import KometaDataset
from anime_catalog.models import AnimeEntry
from anime_catalog.providers.anilist import normalize_media
from anime_catalog.storage.database import Database

FIXTURES = Path(__file__).parent / "fixtures"


def no_sleep(_seconds: float) -> None:
    return None


# ---------------------------------------------------------------------- datos


@pytest.fixture(scope="session")
def raw_media() -> dict[int, dict[str, Any]]:
    data = json.loads((FIXTURES / "anilist_media.json").read_text(encoding="utf-8"))
    return {m["id"]: m for m in data}


@pytest.fixture
def entries(raw_media) -> dict[int, AnimeEntry]:
    return {i: normalize_media(copy.deepcopy(m)) for i, m in raw_media.items()}


def load_fixture_index(db: Database, tmp: Path, sources: tuple[str, ...] = ("anibridge", "kometa", "fribb")) -> None:
    files = {
        "anibridge": (AniBridgeDataset, "anibridge_mappings.json"),
        "kometa": (KometaDataset, "kometa_anime_ids.json"),
        "fribb": (FribbDataset, "fribb_anime_list.json"),
    }
    for name in sources:
        cls, fname = files[name]
        ds = cls(tmp)
        rows = list(ds.parse(FIXTURES / fname))
        ds._write_index(db, rows)
        db.conn.execute(
            "INSERT OR REPLACE INTO datasets(source, version, status, rows) VALUES(?,?,?,?)",
            (name, f"fixture-{name}", "ok", len(rows)),
        )


@pytest.fixture
def index_db(tmp_path) -> Database:
    db = Database(tmp_path / "test.db")
    load_fixture_index(db, tmp_path / "datasets")
    return db


# ---------------------------------------------------------------------- AniList simulado


class FakeAniList:
    """Responde a las consultas GraphQL del cliente usando los fixtures (o medios añadidos)."""

    def __init__(self, media: dict[int, dict[str, Any]]):
        self.media = {k: copy.deepcopy(v) for k, v in media.items()}
        self.requests: list[dict[str, Any]] = []
        self.page_cap: int | None = None  # simula el límite de resultados de AniList

    @staticmethod
    def _fuzzy(m: dict[str, Any]) -> int | None:
        sd = m.get("startDate") or {}
        if not sd.get("year"):
            return None
        return sd["year"] * 10000 + (sd.get("month") or 0) * 100 + (sd.get("day") or 0)

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        q, v = body["query"], body.get("variables") or {}
        self.requests.append(body)
        if "id_in" in q and ("ids" in v or "idMals" in v):
            if v.get("ids"):
                found = [self.media[i] for i in v["ids"] if i in self.media]
            else:
                found = [m for m in self.media.values() if m.get("idMal") in (v.get("idMals") or [])]
            return httpx.Response(200, json={"data": {"Page": {"media": found}}}, headers={"X-RateLimit-Limit": "90", "X-RateLimit-Remaining": "80"})
        if "studios(search" in q:
            name = (v.get("search") or "").casefold()
            studios = {}
            for m in self.media.values():
                for e in (m.get("studios") or {}).get("edges") or []:
                    n = e["node"]
                    if name in n["name"].casefold():
                        studios[n["id"]] = {"id": n["id"], "name": n["name"], "isAnimationStudio": n.get("isAnimationStudio", True)}
            return httpx.Response(200, json={"data": {"Page": {"studios": list(studios.values())}}})
        if "Studio(id" in q:
            sid = v["id"]
            nodes = [m for m in self.media.values() if any(e["node"]["id"] == sid for e in (m.get("studios") or {}).get("edges") or [])]
            nodes.sort(key=lambda m: (self._fuzzy(m) or 0, m["id"]))
            return httpx.Response(200, json={"data": {"Studio": {"id": sid, "name": "x", "media": {
                "pageInfo": {"total": len(nodes), "currentPage": 1, "lastPage": 1, "hasNextPage": False}, "nodes": nodes}}}})
        if "Page(page: $page" in q:
            items = []
            for m in self.media.values():
                f = self._fuzzy(m)
                if "greater" in v and (f is None or f <= v["greater"]):
                    continue
                if "lesser" in v and (f is None or f >= v["lesser"]):
                    continue
                if v.get("formats") and m.get("format") not in v["formats"]:
                    continue
                if v.get("isAdult") is False and m.get("isAdult"):
                    continue
                if v.get("minScore") is not None and (m.get("averageScore") or 0) <= v["minScore"]:
                    continue
                if v.get("status") and m.get("status") not in v["status"]:
                    continue
                items.append(m)
            items.sort(key=lambda m: (self._fuzzy(m) or 0, m["id"]))
            page, per = v.get("page", 1), v.get("perPage", 50)
            if self.page_cap is not None:
                # Como AniList: más allá del tope no hay resultados aunque existan.
                visible = items[: self.page_cap]
                chunk = visible[(page - 1) * per : page * per]
                has_next = page * per < len(items)
            else:
                chunk = items[(page - 1) * per : page * per]
                has_next = page * per < len(items)
            return httpx.Response(200, json={"data": {"Page": {
                "pageInfo": {"total": 5000 if has_next else len(items), "perPage": per, "currentPage": page, "lastPage": 100 if has_next else page,
                             "hasNextPage": has_next}, "media": chunk}}}, headers={"X-RateLimit-Limit": "90", "X-RateLimit-Remaining": "80"})
        return httpx.Response(400, json={"errors": [{"message": "consulta no simulada"}]})

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)


# ---------------------------------------------------------------------- MDBList simulado


class FakeMDBList:
    """Servidor MDBList en memoria con la forma de respuesta de la especificación OpenAPI."""

    def __init__(self, api_key: str = "test-key"):
        self.api_key = api_key
        self.lists: dict[int, dict[str, Any]] = {}
        self.items: dict[int, list[tuple[str, int]]] = {}
        self.next_id = 1000
        self.calls: list[tuple[str, str, Any]] = []
        self.unknown_tmdb: set[tuple[str, int]] = set()  # elementos que MDBList "no encuentra"
        self.fail_writes_after: int | None = None  # interrumpe tras N escrituras de elementos
        self.fail_mode: str = "daily"  # daily | 500
        self.rate_limit_once = False
        self.partial_response = False
        self.writes = 0
        self.page_size_override: int | None = None

    def add_list(self, name: str, items: list[tuple[str, int]] | None = None) -> int:
        lid = self.next_id
        self.next_id += 1
        self.lists[lid] = {"id": lid, "name": name, "slug": re.sub(r"\W+", "-", name.lower()), "items": 0}
        self.items[lid] = list(items or [])
        return lid

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        payload = json.loads(request.content) if request.content else None
        self.calls.append((request.method, path, payload))
        if request.url.params.get("apikey") != self.api_key:
            return httpx.Response(401, json={"error": "Invalid API key"})
        if self.rate_limit_once:
            self.rate_limit_once = False
            return httpx.Response(429, json={"error": "API rate limit exceeded!"}, headers={"Retry-After": "1"})
        if path == "/user":
            return httpx.Response(200, json={"user_id": 1, "username": "tester", "api_requests": 1000, "api_requests_count": 1})
        if path == "/lists/user" and request.method == "GET":
            return httpx.Response(200, json=[{**v, "items": len(self.items[k])} for k, v in self.lists.items()])
        if path == "/lists/user/add" and request.method == "POST":
            lid = self.add_list(payload["name"])
            return httpx.Response(200, json={"id": lid, "name": payload["name"], "slug": self.lists[lid]["slug"]})
        m = re.match(r"^/lists/(\d+)$", path)
        if m and request.method == "GET":
            lid = int(m.group(1))
            if lid not in self.lists:
                return httpx.Response(404, json={"error": "not found"})
            return httpx.Response(200, json={**self.lists[lid], "items": len(self.items[lid])})
        m = re.match(r"^/lists/(\d+)/items$", path)
        if m and request.method == "GET":
            lid = int(m.group(1))
            limit = self.page_size_override or int(request.url.params.get("limit", 100))
            start = int(request.url.params.get("cursor") or 0)
            chunk = self.items[lid][start : start + limit]
            body: dict[str, Any] = {
                "movies": [{"id": t, "title": f"movie {t}", "mediatype": "movie", "ids": {"tmdb": t}} for k, t in chunk if k == "movie"],
                "shows": [{"id": t, "title": f"show {t}", "mediatype": "show"} for k, t in chunk if k == "tv"],
            }
            more = start + limit < len(self.items[lid])
            if more:
                body["pagination"] = {"next_cursor": str(start + limit), "has_more": True}
            return httpx.Response(200, json=body, headers={"X-Has-More": "true" if more else "false"})
        m = re.match(r"^/lists/(\d+)/items/(add|remove)$", path)
        if m and request.method == "POST":
            lid, action = int(m.group(1)), m.group(2)
            reqs = [("movie", int(x["tmdb"])) for x in payload.get("movies", [])] + [("tv", int(x["tmdb"])) for x in payload.get("shows", [])]
            if self.fail_writes_after is not None and self.writes + len(reqs) > self.fail_writes_after:
                if self.fail_mode == "daily":
                    return httpx.Response(429, json={"error": "Daily API limit exceeded!"}, headers={"Retry-After": "3600"})
                return httpx.Response(500, json={"error": "boom"})
            self.writes += len(reqs)
            res = {"added": {"movies": 0, "shows": 0}, "existing": {"movies": 0, "shows": 0}, "not_found": {"movies": 0, "shows": 0},
                   "removed": {"movies": 0, "shows": 0}}
            for ident in reqs:
                key = "movies" if ident[0] == "movie" else "shows"
                if action == "add":
                    if ident in self.unknown_tmdb:
                        res["not_found"][key] += 1
                    elif ident in self.items[lid]:
                        res["existing"][key] += 1
                    else:
                        self.items[lid].append(ident)
                        res["added"][key] += 1
                else:
                    if ident in self.items[lid]:
                        self.items[lid].remove(ident)
                        res["removed"][key] += 1
            if self.partial_response:
                res["added"] = {"movies": 0, "shows": max(0, res["added"]["shows"] - 1)}
            return httpx.Response(200, json=res)
        return httpx.Response(404, json={"error": f"ruta no simulada {request.method} {path}"})

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    def write_calls(self) -> list[tuple[str, str, Any]]:
        return [c for c in self.calls if c[0] == "POST"]


# ---------------------------------------------------------------------- TMDB simulado


class FakeTMDB:
    def __init__(self) -> None:
        self.details: dict[tuple[str, int], dict[str, Any]] = {}
        self.find_results: dict[str, dict[str, list[dict[str, Any]]]] = {}
        self.search_results: dict[str, list[dict[str, Any]]] = {}
        self.calls: list[str] = []

    def add(self, media_type: str, tmdb_id: int, name: str, date: str, *, original_name: str | None = None, tvdb_id: int | None = None,
            imdb_id: str | None = None, genres: tuple[int, ...] = (16,), lang: str = "ja", alts: tuple[str, ...] = ()) -> None:
        body = {"id": tmdb_id, "original_language": lang, "genres": [{"id": g} for g in genres],
                "external_ids": {"tvdb_id": tvdb_id, "imdb_id": imdb_id}}
        if media_type == "tv":
            body.update({"name": name, "original_name": original_name or name, "first_air_date": date, "origin_country": ["JP"],
                         "alternative_titles": {"results": [{"title": a} for a in alts]}, "seasons": []})
        else:
            body.update({"title": name, "original_title": original_name or name, "release_date": date, "imdb_id": imdb_id,
                         "alternative_titles": {"titles": [{"title": a} for a in alts]}})
        self.details[(media_type, tmdb_id)] = body

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.replace("/3", "", 1) if request.url.path.startswith("/3/") else request.url.path
        self.calls.append(path)
        m = re.match(r"^/(tv|movie)/(\d+)$", path)
        if m:
            d = self.details.get((m.group(1), int(m.group(2))))
            return httpx.Response(200, json=d) if d else httpx.Response(404, json={"status_code": 34})
        m = re.match(r"^/find/(.+)$", path)
        if m:
            return httpx.Response(200, json=self.find_results.get(m.group(1), {"tv_results": [], "movie_results": []}))
        m = re.match(r"^/search/(tv|movie)$", path)
        if m:
            q = request.url.params.get("query", "")
            return httpx.Response(200, json={"results": self.search_results.get(q, [])})
        return httpx.Response(404, json={})

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)


# ---------------------------------------------------------------------- contexto de aplicación


@pytest.fixture
def fake_anilist(raw_media) -> FakeAniList:
    return FakeAniList(raw_media)


@pytest.fixture
def fake_mdblist() -> FakeMDBList:
    return FakeMDBList()


@pytest.fixture
def fake_tmdb() -> FakeTMDB:
    return FakeTMDB()


@pytest.fixture
def make_context(tmp_path, fake_anilist, fake_mdblist) -> Callable[..., AppContext]:
    created: list[AppContext] = []

    def factory(*, mdblist_key: str | None = "test-key", tmdb: FakeTMDB | None = None, db_name: str = "app.db") -> AppContext:
        settings = Settings(
            mdblist_api_key=mdblist_key,
            tmdb_api_key="tmdb-key" if tmdb else None,
            database_path=tmp_path / db_name,
            datasets_dir=tmp_path / "datasets",
            reports_dir=tmp_path / "reports",
            overrides_path=tmp_path / "overrides.yaml",
            mdblist_api_url="https://api.mdblist.test",
            tmdb_api_url="https://api.tmdb.test/3",
        )
        transports = Transports(
            anilist=fake_anilist.transport(), mdblist=fake_mdblist.transport(), tmdb=tmdb.transport() if tmdb else None,
            sleep=no_sleep,
        )
        ctx = build_context(settings, transports=transports)
        if not ctx.index.has_data():
            load_fixture_index(ctx.db, tmp_path / "datasets")
        created.append(ctx)
        return ctx

    yield factory
    for c in created:
        try:
            c.close()
        except Exception:
            pass
