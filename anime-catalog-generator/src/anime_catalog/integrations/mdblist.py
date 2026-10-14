"""Cliente de la API de MDBList (https://api.mdblist.com).

Endpoints verificados en la especificación OpenAPI oficial (https://api.mdblist.com/schema/,
consultada el 2026-10-14) y coherentes con `modules/mdblist.py` de Kometa (MIT):

- GET  /user                         información de la cuenta y cuotas
- GET  /lists/user                   listas del usuario -> [{id, name, slug, items, ...}]
- POST /lists/user/add               crea una lista estática {name, private} -> {id, name, slug}
- GET  /lists/{id}                   metadatos de una lista
- GET  /lists/{id}/items             elementos {movies:[...], shows:[...]} con paginación por cursor
- POST /lists/{id}/items/{add|remove}  {"movies":[{"tmdb":N}], "shows":[{"tmdb":N}]}
                                     -> {added, removed, existing, not_found}

Autenticación: parámetro `apikey`. Límites: cuota diaria según el plan y, por cada ventana fija de
5 minutos, 1000 lecturas y 300 escrituras. Un 429 trae `Retry-After`; el campo `error` distingue
"Daily API limit exceeded!" (no se reintenta) de "API rate limit exceeded!" (se espera y reintenta).

A diferencia de `sync_list()` de Kometa, este cliente NUNCA vacía una lista para volver a llenarla:
las altas y bajas se calculan por diferencias en `integrations/sync.py`.
"""

from __future__ import annotations

import logging
from typing import Any, Literal

import httpx

from ..http import HttpClient, HttpError, RateLimitError

log = logging.getLogger(__name__)

Identity = tuple[Literal["tv", "movie"], int]


class MDBListError(HttpError):
    pass


class MDBListAuthError(MDBListError):
    pass


def _daily_limit(resp: httpx.Response) -> str | None:
    try:
        error = str((resp.json() or {}).get("error", ""))
    except ValueError:
        error = resp.text
    if "daily" in error.lower():
        return (
            "límite diario de la API de MDBList agotado (HTTP 429). Espera al reinicio (00:00 UTC) "
            "o revisa tu plan; la próxima ejecución reanudará sin duplicar elementos."
        )
    return None


def _count(value: Any) -> int:
    """Cuenta elementos de un bloque de respuesta {movies: n|[...], shows: n|[...]} o similar."""
    if value is None:
        return 0
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, list):
        return len(value)
    if isinstance(value, dict):
        return sum(_count(v) for v in value.values())
    return 0


class MDBListClient:
    def __init__(
        self,
        api_key: str,
        base_url: str = "https://api.mdblist.com",
        *,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 60.0,
        min_interval: float = 1.05,  # 300 escrituras / 5 min => 1 por segundo
        sleep: Any = None,
    ):
        if not api_key:
            raise MDBListAuthError("Falta MDBLIST_API_KEY")
        kwargs: dict[str, Any] = {"sleep": sleep} if sleep is not None else {}
        self.http = HttpClient(
            base_url.rstrip("/"), timeout=timeout, min_interval=min_interval, transport=transport,
            secrets=[api_key], name="MDBList", **kwargs,
        )
        self.http.fatal_429 = _daily_limit
        self.api_key = api_key

    def close(self) -> None:
        self.http.close()

    # ------------------------------------------------------------------ bajo nivel
    def _call(self, method: str, path: str, *, params: dict[str, Any] | None = None, json: Any = None) -> tuple[Any, httpx.Headers]:
        try:
            resp = self.http.request(method, path, params={"apikey": self.api_key, **(params or {})}, json=json)
        except RateLimitError as err:
            raise MDBListError(str(err), status=429) from err
        if resp.status_code in (401, 403):
            raise MDBListAuthError(
                f"MDBList: autenticación rechazada (HTTP {resp.status_code}). Revisa MDBLIST_API_KEY.", status=resp.status_code
            )
        if resp.status_code == 429:
            raise MDBListError("MDBList: límite de solicitudes alcanzado tras varios reintentos (HTTP 429)", status=429)
        try:
            body = resp.json()
        except ValueError:
            body = None
        if not 200 <= resp.status_code < 300:
            msg = body.get("error") if isinstance(body, dict) else resp.text[:200]
            raise MDBListError(f"MDBList: HTTP {resp.status_code} en {method} {path}: {msg}", status=resp.status_code, body=body)
        if isinstance(body, dict) and body.get("response") is False:
            raise MDBListError(f"MDBList: {body.get('error') or 'respuesta de error'}", status=resp.status_code, body=body)
        return body, resp.headers

    # ------------------------------------------------------------------ cuenta y listas
    def user(self) -> dict[str, Any]:
        body, _ = self._call("GET", "/user")
        return body if isinstance(body, dict) else {}

    def lists(self) -> list[dict[str, Any]]:
        body, _ = self._call("GET", "/lists/user")
        if isinstance(body, dict):
            body = body.get("lists", [])
        return [x for x in body or [] if isinstance(x, dict)]

    def find_lists(self, name: str) -> list[dict[str, Any]]:
        return [x for x in self.lists() if str(x.get("name", "")).strip() == name.strip()]

    def get_list(self, list_id: int) -> dict[str, Any]:
        body, _ = self._call("GET", f"/lists/{list_id}")
        if isinstance(body, list):
            body = body[0] if body else {}
        return body or {}

    def create_list(self, name: str, private: bool = False) -> dict[str, Any]:
        body, _ = self._call("POST", "/lists/user/add", json={"name": name, "private": private})
        if not isinstance(body, dict):
            body = {}
        list_id = body.get("id") or (body.get("list") or {}).get("id")
        if not list_id:
            # Respaldo usado también por Kometa: volver a consultar las listas por nombre.
            matches = self.find_lists(name)
            if len(matches) == 1:
                return matches[0]
            raise MDBListError(f"MDBList: no se pudo confirmar la creación de la lista {name!r}")
        return {**body, "id": int(list_id)}

    # ------------------------------------------------------------------ elementos
    def list_items(self, list_id: int, page_size: int = 1000) -> dict[Identity, dict[str, Any]]:
        """Todos los elementos actuales de la lista, indexados por ("tv"|"movie", tmdb_id)."""
        out: dict[Identity, dict[str, Any]] = {}
        params: dict[str, Any] = {"limit": page_size}
        offset = 0
        for _ in range(10000):
            body, headers = self._call("GET", f"/lists/{list_id}/items", params=params)
            n = 0
            if isinstance(body, dict):
                for key, mtype in (("movies", "movie"), ("shows", "tv")):
                    for it in body.get(key) or []:
                        ident = _item_identity(it, mtype)
                        if ident:
                            out[ident] = {"title": it.get("title"), "year": it.get("release_year")}
                        n += 1
                pagination = body.get("pagination") or {}
                cursor = pagination.get("next_cursor") or body.get("next_cursor")
            elif isinstance(body, list):
                for it in body:
                    mt = "tv" if str(it.get("mediatype", "")).lower() == "show" else "movie"
                    ident = _item_identity(it, mt)
                    if ident:
                        out[ident] = {"title": it.get("title"), "year": it.get("release_year")}
                    n += 1
                cursor = None
                pagination = {}
            else:
                break
            has_more = str(headers.get("X-Has-More", "")).lower() == "true" or bool(pagination.get("has_more"))
            if cursor:
                params = {"limit": page_size, "cursor": cursor}
                continue
            if has_more and n:
                # Respaldo con `offset` (obsoleto pero admitido) si la respuesta no trae cursor.
                offset += n
                params = {"limit": page_size, "offset": offset}
                continue
            break
        return out

    def modify(self, list_id: int, action: Literal["add", "remove"], items: list[Identity]) -> dict[str, Any]:
        """Añade o quita elementos. Devuelve recuentos y, si la API los detalla, los no encontrados."""
        payload: dict[str, list[dict[str, int]]] = {}
        for mtype, tmdb_id in items:
            payload.setdefault("movies" if mtype == "movie" else "shows", []).append({"tmdb": int(tmdb_id)})
        body, _ = self._call("POST", f"/lists/{list_id}/items/{action}", json=payload)
        body = body if isinstance(body, dict) else {}
        out: dict[str, Any] = {k: _count(body.get(k)) for k in ("added", "removed", "existing", "not_found")}
        out["not_found_ids"] = _listed_ids(body.get("not_found"))
        out["raw"] = body
        return out


def _listed_ids(block: Any) -> list[Identity]:
    """Extrae identidades de un bloque {movies:[{tmdb:..}], shows:[...]} si viene detallado."""
    out: list[Identity] = []
    if isinstance(block, dict):
        for key, mtype in (("movies", "movie"), ("shows", "tv")):
            for it in block.get(key) or [] if isinstance(block.get(key), list) else []:
                if isinstance(it, dict):
                    ident = _item_identity(it, mtype)  # type: ignore[arg-type]
                    if ident:
                        out.append(ident)
    return out


def _item_identity(it: dict[str, Any], mtype: Literal["tv", "movie"]) -> Identity | None:
    ids = it.get("ids") or {}
    tmdb = ids.get("tmdb") or it.get("tmdb_id") or it.get("tmdbid") or it.get("id")
    try:
        return (mtype, int(tmdb))
    except (TypeError, ValueError):
        return None
