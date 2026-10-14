"""Caché persistente con TTL por tipo de dato, sobre la tabla `cache` de SQLite."""

from __future__ import annotations

import json
import time
from typing import Any

from .database import Database

DAY = 86400.0

# TTL por espacio de nombres (segundos). None = no caduca.
DEFAULT_TTLS: dict[str, float | None] = {
    "anilist_query": 1 * DAY,  # IDs devueltos por una partición de consulta
    "anime_finished": 30 * DAY,  # metadatos de animes finalizados
    "anime_airing": 1 * DAY,  # en emisión / próximos estrenos
    "jikan": 7 * DAY,
    "tmdb_valid": 30 * DAY,  # validaciones TMDB confirmadas
    "tmdb_invalid": 3 * DAY,
    "tmdb_find": 14 * DAY,
    "tmdb_search": 7 * DAY,
    "mdblist_lists": 0.0,  # nunca se reutiliza: siempre se consulta el estado real
    "resolution": 30 * DAY,  # resoluciones de mapping (la clave incluye versión de datasets y config)
}


class Cache:
    def __init__(self, db: Database, ttls: dict[str, float | None] | None = None, enabled: bool = True):
        self.db = db
        self.ttls = {**DEFAULT_TTLS, **(ttls or {})}
        self.enabled = enabled
        self.hits = 0
        self.misses = 0

    def ttl_for(self, namespace: str) -> float | None:
        return self.ttls.get(namespace, 7 * DAY)

    def get(self, namespace: str, key: str) -> Any | None:
        if not self.enabled:
            return None
        row = self.db.conn.execute(
            "SELECT value, expires_at FROM cache WHERE namespace=? AND key=?", (namespace, key)
        ).fetchone()
        if row is None or (row["expires_at"] is not None and row["expires_at"] < time.time()):
            self.misses += 1
            return None
        self.hits += 1
        return json.loads(row["value"])

    def set(self, namespace: str, key: str, value: Any, ttl: float | None = -1.0, etag: str | None = None) -> None:
        if ttl == -1.0:
            ttl = self.ttl_for(namespace)
        now = time.time()
        expires = None if ttl is None else now + ttl
        self.db.conn.execute(
            """INSERT INTO cache(namespace, key, value, etag, fetched_at, expires_at) VALUES(?,?,?,?,?,?)
               ON CONFLICT(namespace, key) DO UPDATE SET value=excluded.value, etag=excluded.etag,
               fetched_at=excluded.fetched_at, expires_at=excluded.expires_at""",
            (namespace, key, json.dumps(value, ensure_ascii=False, default=str), etag, now, expires),
        )

    def set_many(self, namespace: str, items: list[tuple[str, Any]], ttl: float | None = -1.0) -> None:
        """Escritura por lotes en UNA transacción (miles de inserciones sin un commit por fila)."""
        if not items:
            return
        if ttl == -1.0:
            ttl = self.ttl_for(namespace)
        now = time.time()
        expires = None if ttl is None else now + ttl
        with self.db.transaction() as conn:
            conn.executemany(
                """INSERT INTO cache(namespace, key, value, etag, fetched_at, expires_at) VALUES(?,?,?,NULL,?,?)
                   ON CONFLICT(namespace, key) DO UPDATE SET value=excluded.value, fetched_at=excluded.fetched_at,
                   expires_at=excluded.expires_at""",
                [(namespace, k, json.dumps(v, ensure_ascii=False, default=str), now, expires) for k, v in items],
            )

    def get_many(self, namespace: str, keys: list[str]) -> dict[str, Any]:
        """Lectura por lotes (una consulta por cada 400 claves en vez de una por clave)."""
        if not self.enabled or not keys:
            return {}
        out: dict[str, Any] = {}
        now = time.time()
        uniq = list(dict.fromkeys(keys))
        for i in range(0, len(uniq), 400):
            chunk = uniq[i : i + 400]
            q = f"SELECT key, value FROM cache WHERE namespace=? AND key IN ({','.join('?' * len(chunk))}) AND (expires_at IS NULL OR expires_at >= ?)"
            for row in self.db.conn.execute(q, (namespace, *chunk, now)):
                out[row["key"]] = json.loads(row["value"])
        self.hits += len(out)
        self.misses += len(uniq) - len(out)
        return out

    def get_etag(self, namespace: str, key: str) -> tuple[str | None, Any | None]:
        row = self.db.conn.execute("SELECT etag, value FROM cache WHERE namespace=? AND key=?", (namespace, key)).fetchone()
        if row is None:
            return None, None
        return row["etag"], json.loads(row["value"]) if row["value"] else None

    def invalidate(self, namespace: str | None = None) -> int:
        if namespace:
            cur = self.db.conn.execute("DELETE FROM cache WHERE namespace=?", (namespace,))
        else:
            cur = self.db.conn.execute("DELETE FROM cache")
        return cur.rowcount

    def purge_expired(self) -> int:
        cur = self.db.conn.execute("DELETE FROM cache WHERE expires_at IS NOT NULL AND expires_at < ?", (time.time(),))
        return cur.rowcount
