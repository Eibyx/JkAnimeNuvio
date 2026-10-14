"""Cliente de TMDB API v3 (detalles, IDs externos, /find y búsqueda), con caché persistente.

Autenticación: `api_key` (v3, parámetro de consulta) o token de lectura v4 (`Authorization: Bearer`).
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Literal

import httpx

from ..http import HttpClient, HttpError
from ..storage.cache import Cache

log = logging.getLogger(__name__)

APPEND = "external_ids,alternative_titles"


class TMDBClient:
    def __init__(
        self,
        base_url: str,
        cache: Cache,
        *,
        api_key: str | None = None,
        read_token: str | None = None,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 30.0,
        language: str = "en-US",
        sleep: Any = None,
    ):
        if not api_key and not read_token:
            raise ValueError("TMDB requiere TMDB_API_KEY o TMDB_READ_ACCESS_TOKEN")
        headers = {"Authorization": f"Bearer {read_token}"} if read_token else {}
        self.params = {"api_key": api_key} if api_key and not read_token else {}
        # TMDB permite ~40-50 solicitudes/s; se usa un margen conservador.
        kwargs: dict[str, Any] = {"sleep": sleep} if sleep is not None else {}
        self.http = HttpClient(
            base_url.rstrip("/"), timeout=timeout, min_interval=0.03, headers=headers, transport=transport,
            secrets=[s for s in (api_key, read_token) if s], name="TMDB", **kwargs,
        )
        self.cache = cache
        self.language = language

    def close(self) -> None:
        self.http.close()

    def _get(self, path: str, params: dict[str, Any] | None = None) -> tuple[int, Any]:
        resp = self.http.request("GET", path, params={**self.params, **(params or {})})
        if resp.status_code == 401:
            raise HttpError("TMDB: credenciales inválidas (HTTP 401). Revisa TMDB_API_KEY / TMDB_READ_ACCESS_TOKEN.", status=401)
        try:
            body = resp.json()
        except ValueError:
            body = None
        return resp.status_code, body

    def details(self, media_type: Literal["tv", "movie"], tmdb_id: int) -> dict[str, Any] | None:
        """Detalles con external_ids y títulos alternativos. None si no existe (404)."""
        key = f"{media_type}:{tmdb_id}"
        cached = self.cache.get("tmdb_valid", key)
        if cached is not None:
            return cached
        if self.cache.get("tmdb_invalid", key) is not None:
            return None
        status, body = self._get(f"/{media_type}/{tmdb_id}", {"append_to_response": APPEND, "language": self.language})
        if status == 404:
            self.cache.set("tmdb_invalid", key, {"status": 404})
            return None
        if status != 200 or not isinstance(body, dict):
            raise HttpError(f"TMDB: HTTP {status} en /{media_type}/{tmdb_id}", status=status, body=body)
        slim = slim_details(media_type, body)
        self.cache.set("tmdb_valid", key, slim)
        return slim

    def prefetch_details(self, items: list[tuple[str, int]], workers: int = 4) -> int:
        """Descarga en paralelo (concurrencia limitada y respetando el intervalo mínimo) los detalles
        que no están en caché. Solo la red va en hilos; la caché SQLite se escribe en el hilo actual.
        Devuelve el número de solicitudes realizadas."""
        todo = []
        for mt, tid in items:
            key = f"{mt}:{tid}"
            if self.cache.get("tmdb_valid", key) is None and self.cache.get("tmdb_invalid", key) is None:
                todo.append((mt, tid))
        if not todo:
            return 0

        def fetch(item: tuple[str, int]) -> tuple[tuple[str, int], int, Any]:
            mt, tid = item
            try:
                return item, *self._get(f"/{mt}/{tid}", {"append_to_response": APPEND, "language": self.language})
            except HttpError as err:
                return item, err.status or 0, None

        with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
            results = list(pool.map(fetch, todo))
        for (mt, tid), status, body in results:
            key = f"{mt}:{tid}"
            if status == 404:
                self.cache.set("tmdb_invalid", key, {"status": 404})
            elif status == 200 and isinstance(body, dict):
                self.cache.set("tmdb_valid", key, slim_details(mt, body))
        return len(todo)

    def find(self, external_id: str, source: Literal["tvdb_id", "imdb_id"]) -> dict[str, list[dict[str, Any]]]:
        key = f"{source}:{external_id}"
        cached = self.cache.get("tmdb_find", key)
        if cached is not None:
            return cached
        status, body = self._get(f"/find/{external_id}", {"external_source": source})
        if status != 200 or not isinstance(body, dict):
            return {}
        out = {
            k: [_slim_result(r) for r in body.get(k) or []]
            for k in ("tv_results", "movie_results", "tv_season_results", "tv_episode_results")
        }
        self.cache.set("tmdb_find", key, out)
        return out

    def search(self, media_type: Literal["tv", "movie"], query: str, year: int | None = None) -> list[dict[str, Any]]:
        key = f"{media_type}:{query}:{year}"
        cached = self.cache.get("tmdb_search", key)
        if cached is not None:
            return cached
        params: dict[str, Any] = {"query": query, "include_adult": "false"}
        if year:
            params["first_air_date_year" if media_type == "tv" else "primary_release_year"] = year
        status, body = self._get(f"/search/{media_type}", params)
        if status != 200 or not isinstance(body, dict):
            return []
        out = [_slim_result(r) for r in (body.get("results") or [])[:10]]
        self.cache.set("tmdb_search", key, out)
        return out


def _slim_result(r: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": r.get("id"),
        "name": r.get("name") or r.get("title"),
        "original_name": r.get("original_name") or r.get("original_title"),
        "date": r.get("first_air_date") or r.get("release_date"),
        "original_language": r.get("original_language"),
        "origin_country": r.get("origin_country") or [],
        "genre_ids": r.get("genre_ids") or [],
        "show_id": r.get("show_id"),
        "media_type": r.get("media_type"),
    }


def slim_details(media_type: str, body: dict[str, Any]) -> dict[str, Any]:
    alts = body.get("alternative_titles") or {}
    alt_list = alts.get("results") if media_type == "tv" else alts.get("titles")
    ext = body.get("external_ids") or {}
    return {
        "media_type": media_type,
        "id": body.get("id"),
        "name": body.get("name") or body.get("title"),
        "original_name": body.get("original_name") or body.get("original_title"),
        "date": body.get("first_air_date") or body.get("release_date"),
        "original_language": body.get("original_language"),
        "origin_country": body.get("origin_country") or [c.get("iso_3166_1") for c in body.get("production_countries") or []],
        "genres": [g.get("id") for g in body.get("genres") or []],
        "alternative_titles": [a.get("title") for a in alt_list or [] if a.get("title")][:40],
        "tvdb_id": ext.get("tvdb_id"),
        "imdb_id": ext.get("imdb_id") or body.get("imdb_id"),
        "seasons": [s.get("season_number") for s in body.get("seasons") or []],
        "number_of_episodes": body.get("number_of_episodes"),
    }
