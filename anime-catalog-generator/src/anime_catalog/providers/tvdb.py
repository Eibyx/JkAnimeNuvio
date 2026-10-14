"""Cliente opcional de TheTVDB API v4.

No es necesario para el flujo normal: los TVDB IDs proceden de los datasets y la conversión a TMDB
se hace con `/find` de TMDB. Solo se usa para mostrar el nombre/año de una serie de TVDB en
`anime-catalog mapping` cuando hay `TVDB_API_KEY`. Si no hay clave, el resto del sistema funciona igual.
"""

from __future__ import annotations

from typing import Any

import httpx

from ..http import HttpClient
from ..storage.cache import Cache


class TVDBClient:
    def __init__(self, cache: Cache, api_key: str, pin: str | None = None, *, base_url: str = "https://api4.thetvdb.com/v4",
                 transport: httpx.BaseTransport | None = None):
        self.http = HttpClient(base_url, min_interval=0.1, transport=transport, secrets=[api_key] + ([pin] if pin else []), name="TVDB")
        self.cache = cache
        self.api_key = api_key
        self.pin = pin
        self._token: str | None = None

    def close(self) -> None:
        self.http.close()

    def _login(self) -> None:
        payload = {"apikey": self.api_key, **({"pin": self.pin} if self.pin else {})}
        body = self.http.post_json("/login", json=payload)
        self._token = (body.get("data") or {}).get("token")
        if not self._token:
            raise RuntimeError("TVDB: no se obtuvo token de acceso")

    def series(self, tvdb_id: int) -> dict[str, Any] | None:
        key = f"series:{tvdb_id}"
        cached = self.cache.get("tvdb", key)
        if cached is not None:
            return cached
        if not self._token:
            self._login()
        resp = self.http.request("GET", f"/series/{tvdb_id}", headers={"Authorization": f"Bearer {self._token}"})
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        data = resp.json().get("data") or {}
        out = {"id": data.get("id"), "name": data.get("name"), "year": data.get("year"), "first_aired": data.get("firstAired")}
        self.cache.set("tvdb", key, out)
        return out
