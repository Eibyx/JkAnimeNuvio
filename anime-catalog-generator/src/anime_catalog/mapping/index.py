"""Consultas sobre el índice local de mappings (SQLite), con búsquedas directas e inversas."""

from __future__ import annotations

from dataclasses import dataclass

from ..storage.database import Database
from .anibridge import AniBridgeDataset
from .anime_lists import AnimeListsDataset
from .base import MappingDataset
from .fribb import FribbDataset
from .kometa import KometaDataset

DATASET_CLASSES: dict[str, type[MappingDataset]] = {
    "anibridge": AniBridgeDataset,
    "kometa": KometaDataset,
    "fribb": FribbDataset,
    "anime_lists": AnimeListsDataset,
}


@dataclass(frozen=True, slots=True)
class IndexHit:
    source: str
    src_provider: str
    src_id: str
    src_scope: str | None
    dst_provider: str
    dst_id: str
    dst_scope: str | None
    detail: str | None
    reverse: bool = False

    def describe(self) -> str:
        s = f"{self.src_provider}:{self.src_id}" + (f":{self.src_scope}" if self.src_scope else "")
        d = f"{self.dst_provider}:{self.dst_id}" + (f":{self.dst_scope}" if self.dst_scope else "")
        arrow = "<-" if self.reverse else "->"
        return f"{self.source}: {s} -> {d}" if not self.reverse else f"{self.source} (inverso): {d} {arrow} {s}"


def season_of(scope: str | None) -> int | None:
    if scope and scope.startswith("s") and scope[1:].isdigit():
        return int(scope[1:])
    return None


_COLS = "source, src_provider, src_id, src_scope, dst_provider, dst_id, dst_scope, detail"
Key = tuple[str, str]


class MappingIndex:
    """Acceso al índice SQLite con caché en memoria acotada y precarga por lotes.

    Cada (proveedor, id) se consulta una sola vez por proceso en cada dirección; `prefetch` resuelve
    cientos de IDs con una consulta `IN (...)` en lugar de una consulta por anime.
    """

    CHUNK = 400  # por debajo del límite de variables de SQLite en Android antiguos (999)

    def __init__(self, db: Database, max_cached_keys: int = 60000):
        self.db = db
        self.max_cached_keys = max_cached_keys
        self._fwd: dict[Key, list[IndexHit]] = {}
        self._rev: dict[Key, list[IndexHit]] = {}
        self._versions: dict[str, str] | None = None
        self.queries = 0

    def clear_cache(self) -> None:
        """Libera las filas cacheadas (las versiones de datasets se conservan)."""
        self._fwd.clear()
        self._rev.clear()

    def has_data(self, source: str | None = None) -> bool:
        if source:
            row = self.db.conn.execute("SELECT 1 FROM mapping_index WHERE source=? LIMIT 1", (source,)).fetchone()
        else:
            row = self.db.conn.execute("SELECT 1 FROM mapping_index LIMIT 1").fetchone()
        return row is not None

    def loaded_sources(self) -> list[str]:
        return [r[0] for r in self.db.conn.execute("SELECT source FROM datasets WHERE status='ok' AND rows > 0")]

    def dataset_versions(self) -> dict[str, str]:
        if self._versions is None:
            self._versions = {r["source"]: r["version"] or "?" for r in
                              self.db.conn.execute("SELECT source, version FROM datasets WHERE status='ok'")}
        return dict(self._versions)

    # ------------------------------------------------------------------ carga
    def _store(self, cache: dict[Key, list[IndexHit]], keys: list[Key], hits: list[IndexHit], reverse: bool) -> None:
        if len(cache) + len(keys) > self.max_cached_keys:
            cache.clear()  # límite de memoria: se descarta todo y se vuelve a cargar bajo demanda
        for k in keys:
            cache[k] = []
        for h in hits:
            k = (h.dst_provider, h.dst_id) if reverse else (h.src_provider, h.src_id)
            cache.setdefault(k, []).append(h)

    def _load(self, keys: list[Key], reverse: bool) -> None:
        cache = self._rev if reverse else self._fwd
        todo = sorted({k for k in keys if k not in cache})
        if not todo:
            return
        pcol, icol = ("dst_provider", "dst_id") if reverse else ("src_provider", "src_id")
        by_provider: dict[str, list[str]] = {}
        for p, i in todo:
            by_provider.setdefault(p, []).append(i)
        for provider, ids in by_provider.items():
            for n in range(0, len(ids), self.CHUNK):
                chunk = ids[n : n + self.CHUNK]
                q = f"SELECT {_COLS} FROM mapping_index WHERE {pcol}=? AND {icol} IN ({','.join('?' * len(chunk))})"
                self.queries += 1
                rows = self.db.conn.execute(q, (provider, *chunk)).fetchall()
                hits = [IndexHit(*r, reverse=reverse) for r in rows]
                self._store(cache, [(provider, i) for i in chunk], hits, reverse)

    def prefetch(self, keys: list[tuple[str, str | int]], reverse: bool = True) -> None:
        """Precarga por lotes las filas directas (y opcionalmente inversas) de muchos IDs."""
        norm = [(p, str(i)) for p, i in keys]
        self._load(norm, reverse=False)
        if reverse:
            self._load(norm, reverse=True)

    # ------------------------------------------------------------------ consultas
    def forward(self, provider: str, ident: str | int, sources: list[str] | None = None) -> list[IndexHit]:
        key = (provider, str(ident))
        if key not in self._fwd:
            self._load([key], reverse=False)
        hits = self._fwd.get(key, [])
        return hits if sources is None else [h for h in hits if h.source in sources]

    def reverse(self, provider: str, ident: str | int, sources: list[str] | None = None) -> list[IndexHit]:
        """Filas cuyo DESTINO es provider:ident (relación en sentido contrario)."""
        key = (provider, str(ident))
        if key not in self._rev:
            self._load([key], reverse=True)
        hits = self._rev.get(key, [])
        return hits if sources is None else [h for h in hits if h.source in sources]

    def anime_ids_for_show(self, tmdb_show_id: int) -> list[tuple[str, int, int | None, str]]:
        """IDs de anime (anilist/mal) asociados a una serie de TMDB: (provider, id, temporada, fuente)."""
        out: set[tuple[str, int, int | None, str]] = set()
        for h in self.reverse("tmdb_show", tmdb_show_id):
            if h.src_provider in ("anilist", "mal") and h.src_id.isdigit():
                out.add((h.src_provider, int(h.src_id), season_of(h.dst_scope), h.source))
        for h in self.forward("tmdb_show", tmdb_show_id):
            if h.dst_provider in ("anilist", "mal") and h.dst_id.isdigit():
                out.add((h.dst_provider, int(h.dst_id), season_of(h.src_scope), h.source))
        return sorted(out, key=lambda x: (x[2] if x[2] is not None else 999, x[1]))

    def show_ids_for(self, provider: str, ident: int, sources: list[str] | None = None) -> set[int]:
        """Series de TMDB a las que apunta una entrada (directo + inverso + vía AniDB)."""
        out: set[int] = set()
        for h in self.forward(provider, ident, sources):
            if h.dst_provider == "tmdb_show" and h.dst_id.isdigit():
                out.add(int(h.dst_id))
        for h in self.reverse(provider, ident, sources):
            if h.src_provider == "tmdb_show" and h.src_id.isdigit():
                out.add(int(h.src_id))
        return out

    def tvdb_show_ids_for(self, provider: str, ident: int) -> set[int]:
        out: set[int] = set()
        for h in self.forward(provider, ident):
            if h.dst_provider == "tvdb_show" and h.dst_id.isdigit():
                out.add(int(h.dst_id))
        return out
