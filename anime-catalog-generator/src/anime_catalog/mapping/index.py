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


@dataclass(frozen=True)
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


class MappingIndex:
    def __init__(self, db: Database):
        self.db = db

    def has_data(self, source: str | None = None) -> bool:
        if source:
            row = self.db.conn.execute("SELECT 1 FROM mapping_index WHERE source=? LIMIT 1", (source,)).fetchone()
        else:
            row = self.db.conn.execute("SELECT 1 FROM mapping_index LIMIT 1").fetchone()
        return row is not None

    def loaded_sources(self) -> list[str]:
        return [r[0] for r in self.db.conn.execute("SELECT DISTINCT source FROM mapping_index")]

    def dataset_versions(self) -> dict[str, str]:
        return {r["source"]: r["version"] or "?" for r in self.db.conn.execute("SELECT source, version FROM datasets WHERE status='ok'")}

    def forward(self, provider: str, ident: str | int, sources: list[str] | None = None) -> list[IndexHit]:
        rows = self.db.conn.execute(
            "SELECT source, src_provider, src_id, src_scope, dst_provider, dst_id, dst_scope, detail FROM mapping_index "
            "WHERE src_provider=? AND src_id=?",
            (provider, str(ident)),
        )
        return [IndexHit(*r) for r in rows if sources is None or r[0] in sources]

    def reverse(self, provider: str, ident: str | int, sources: list[str] | None = None) -> list[IndexHit]:
        """Filas cuyo DESTINO es provider:ident (relación en sentido contrario)."""
        rows = self.db.conn.execute(
            "SELECT source, src_provider, src_id, src_scope, dst_provider, dst_id, dst_scope, detail FROM mapping_index "
            "WHERE dst_provider=? AND dst_id=?",
            (provider, str(ident)),
        )
        return [IndexHit(*r, reverse=True) for r in rows if sources is None or r[0] in sources]

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
