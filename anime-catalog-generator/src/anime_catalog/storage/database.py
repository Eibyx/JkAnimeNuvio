"""Base de datos SQLite local: metadatos, relaciones, índices de mappings, overrides y sincronizaciones."""

from __future__ import annotations

import json
import sqlite3
import time
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- ANIME: metadatos normalizados (JSON completo + columnas indexadas)
CREATE TABLE IF NOT EXISTS anime (
    uid TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    anilist_id INTEGER,
    mal_id INTEGER,
    title TEXT,
    format TEXT,
    status TEXT,
    start_year INTEGER,
    start_date INTEGER,
    average_score INTEGER,
    data TEXT NOT NULL,
    fetched_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_anime_anilist ON anime(anilist_id);
CREATE INDEX IF NOT EXISTS idx_anime_mal ON anime(mal_id);

-- RELACIONES
CREATE TABLE IF NOT EXISTS relations (
    src_uid TEXT NOT NULL,
    dst_uid TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    PRIMARY KEY (src_uid, dst_uid, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_rel_dst ON relations(dst_uid);

-- CANONICAL ANIME
CREATE TABLE IF NOT EXISTS canonical (
    canonical_uid TEXT PRIMARY KEY,
    original_year INTEGER,
    members TEXT NOT NULL,
    criteria TEXT NOT NULL,
    updated_at REAL NOT NULL
);

-- Índice de mappings construido a partir de los datasets (direccional)
CREATE TABLE IF NOT EXISTS mapping_index (
    source TEXT NOT NULL,
    src_provider TEXT NOT NULL,
    src_id TEXT NOT NULL,
    src_scope TEXT,
    dst_provider TEXT NOT NULL,
    dst_id TEXT NOT NULL,
    dst_scope TEXT,
    detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_map_src ON mapping_index(src_provider, src_id);
CREATE INDEX IF NOT EXISTS idx_map_dst ON mapping_index(dst_provider, dst_id);
CREATE INDEX IF NOT EXISTS idx_map_source ON mapping_index(source);

-- Versiones de datasets descargados
CREATE TABLE IF NOT EXISTS datasets (
    source TEXT PRIMARY KEY,
    version TEXT,
    etag TEXT,
    last_modified TEXT,
    sha256 TEXT,
    path TEXT,
    previous_path TEXT,
    previous_version TEXT,
    downloaded_at REAL,
    indexed_at REAL,
    rows INTEGER,
    status TEXT,
    message TEXT
);

-- MAPPINGS resueltos (resultado del MappingResolver, por entrada canónica)
CREATE TABLE IF NOT EXISTS mappings (
    canonical_uid TEXT PRIMARY KEY,
    anilist_id INTEGER,
    mal_id INTEGER,
    anidb_id INTEGER,
    media_type TEXT,
    tmdb_id INTEGER,
    tvdb_id INTEGER,
    imdb_id TEXT,
    source TEXT,
    status TEXT,
    confidence REAL,
    evidence TEXT,
    dataset_versions TEXT,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mappings_tmdb ON mappings(media_type, tmdb_id);

-- OVERRIDES manuales: separados de los datasets, nunca se borran al actualizar
CREATE TABLE IF NOT EXISTS overrides (
    uid TEXT PRIMARY KEY,
    action TEXT NOT NULL,          -- map | exclude | canonical
    media_type TEXT,
    tmdb_id INTEGER,
    canonical_uid TEXT,
    note TEXT,
    created_at REAL NOT NULL
);

-- Cola de revisión
CREATE TABLE IF NOT EXISTS review_queue (
    uid TEXT PRIMARY KEY,
    title TEXT,
    status TEXT,
    reason TEXT,
    candidates TEXT,
    catalog TEXT,
    updated_at REAL NOT NULL
);

-- Caché genérica con TTL y ETag
CREATE TABLE IF NOT EXISTS cache (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    etag TEXT,
    fetched_at REAL NOT NULL,
    expires_at REAL,
    PRIMARY KEY (namespace, key)
);

-- SINCRONIZACIONES
CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    catalog TEXT,
    list_name TEXT,
    list_id INTEGER,
    mode TEXT,
    dry_run INTEGER,
    started_at REAL,
    finished_at REAL,
    status TEXT,
    summary TEXT,
    dataset_versions TEXT
);
CREATE TABLE IF NOT EXISTS sync_items (
    run_id TEXT NOT NULL,
    list_id INTEGER,
    media_type TEXT NOT NULL,
    tmdb_id INTEGER NOT NULL,
    action TEXT NOT NULL,          -- add | remove | skip_existing
    status TEXT NOT NULL,          -- pending | done | failed | not_found | existing
    error TEXT,
    updated_at REAL NOT NULL,
    PRIMARY KEY (run_id, media_type, tmdb_id, action)
);
-- Trabajos de la interfaz web (estado recuperable tras una interrupción)
CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT,
    status TEXT NOT NULL,
    params TEXT,
    snapshot TEXT,
    list_key TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
-- Elementos que esta aplicación ha añadido a cada lista (conjunto gestionado)
CREATE TABLE IF NOT EXISTS managed_items (
    list_id INTEGER NOT NULL,
    media_type TEXT NOT NULL,
    tmdb_id INTEGER NOT NULL,
    catalog TEXT,
    title TEXT,
    first_run TEXT,
    last_run TEXT,
    PRIMARY KEY (list_id, media_type, tmdb_id)
);
"""


_INITIALIZED: set[str] = set()  # rutas cuyo esquema ya se creó en este proceso (arranque más rápido)


class Database:
    def __init__(self, path: Path | str, check_same_thread: bool = True):
        self.path = Path(path)
        if str(path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        existed = str(path) != ":memory:" and Path(path).exists()
        # Modo autocommit: las transacciones se abren explícitamente con transaction().
        self.conn = sqlite3.connect(str(path), timeout=60, isolation_level=None, check_same_thread=check_same_thread)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        # Ajustes moderados (también válidos en Android): caché de páginas de 8 MB y temporales en
        # memoria. Sin mmap: sus páginas cuentan como memoria residente y en Android penalizan.
        self.conn.execute("PRAGMA cache_size=-8000")
        self.conn.execute("PRAGMA temp_store=MEMORY")
        key = str(Path(path).resolve()) if str(path) != ":memory:" else None
        if key is None or key not in _INITIALIZED or not existed:
            self.conn.executescript(SCHEMA)
            self.set_meta("schema_version", str(SCHEMA_VERSION))
            if key is not None:
                _INITIALIZED.add(key)
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        try:
            self.conn.execute("BEGIN")
            yield self.conn
            self.conn.execute("COMMIT")
        except BaseException:
            self.conn.execute("ROLLBACK")
            raise

    def execute(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
        return self.conn.execute(sql, tuple(params))

    def commit(self) -> None:
        self.conn.commit()

    # ---- meta
    def get_meta(self, key: str) -> str | None:
        row = self.conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row[0] if row else None

    def set_meta(self, key: str, value: str) -> None:
        self.conn.execute("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))

    # ---- overrides
    def list_overrides(self) -> list[dict[str, Any]]:
        return [dict(r) for r in self.conn.execute("SELECT * FROM overrides ORDER BY uid")]

    def get_override(self, uid: str) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM overrides WHERE uid=?", (uid,)).fetchone()
        return dict(row) if row else None

    def set_override(
        self,
        uid: str,
        action: str,
        media_type: str | None = None,
        tmdb_id: int | None = None,
        canonical_uid: str | None = None,
        note: str | None = None,
    ) -> None:
        if action not in {"map", "exclude", "canonical"}:
            raise ValueError(f"acción de override inválida: {action}")
        if action == "map" and (media_type not in {"tv", "movie"} or not tmdb_id):
            raise ValueError("un override 'map' requiere media_type (tv/movie) y tmdb_id")
        if action == "canonical" and not canonical_uid:
            raise ValueError("un override 'canonical' requiere canonical_uid")
        self.conn.execute(
            """INSERT INTO overrides(uid, action, media_type, tmdb_id, canonical_uid, note, created_at)
               VALUES(?,?,?,?,?,?,?)
               ON CONFLICT(uid) DO UPDATE SET action=excluded.action, media_type=excluded.media_type,
               tmdb_id=excluded.tmdb_id, canonical_uid=excluded.canonical_uid, note=excluded.note,
               created_at=excluded.created_at""",
            (uid, action, media_type, tmdb_id, canonical_uid, note, time.time()),
        )
        self.conn.execute("DELETE FROM review_queue WHERE uid=?", (uid,))
        self.conn.commit()

    def delete_override(self, uid: str) -> bool:
        cur = self.conn.execute("DELETE FROM overrides WHERE uid=?", (uid,))
        self.conn.commit()
        return cur.rowcount > 0

    # ---- revisión
    def queue_review(self, uid: str, title: str, status: str, reason: str, candidates: Any, catalog: str) -> None:
        self.conn.execute(
            """INSERT INTO review_queue(uid, title, status, reason, candidates, catalog, updated_at)
               VALUES(?,?,?,?,?,?,?)
               ON CONFLICT(uid) DO UPDATE SET title=excluded.title, status=excluded.status,
               reason=excluded.reason, candidates=excluded.candidates, catalog=excluded.catalog,
               updated_at=excluded.updated_at""",
            (uid, title, status, reason, json.dumps(candidates, ensure_ascii=False), catalog, time.time()),
        )

    def clear_review(self, uid: str) -> None:
        self.conn.execute("DELETE FROM review_queue WHERE uid=?", (uid,))

    def list_review(self, status: str | None = None) -> list[dict[str, Any]]:
        if status:
            rows = self.conn.execute("SELECT * FROM review_queue WHERE status=? ORDER BY updated_at DESC", (status,))
        else:
            rows = self.conn.execute("SELECT * FROM review_queue ORDER BY status, updated_at DESC")
        out = []
        for r in rows:
            d = dict(r)
            d["candidates"] = json.loads(d["candidates"] or "null")
            out.append(d)
        return out
