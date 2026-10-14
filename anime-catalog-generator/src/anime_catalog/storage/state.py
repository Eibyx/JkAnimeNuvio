"""Exportación/importación del estado persistente pequeño (para GitHub Actions u otras máquinas).

Incluye lo que NO se puede reconstruir descargando datasets: elementos gestionados por lista (necesarios
para que `sync` solo elimine lo que añadió esta aplicación), overrides, cola de revisión e historial de
ejecuciones. Los índices de mappings y la caché de metadatos se reconstruyen o se guardan en caché aparte.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .database import Database

STATE_VERSION = 1
TABLES = {
    "managed_items": ["list_id", "media_type", "tmdb_id", "catalog", "title", "first_run", "last_run"],
    "overrides": ["uid", "action", "media_type", "tmdb_id", "canonical_uid", "note", "created_at"],
    "review_queue": ["uid", "title", "status", "reason", "candidates", "catalog", "updated_at"],
    "runs": ["run_id", "catalog", "list_name", "list_id", "mode", "dry_run", "started_at", "finished_at", "status", "summary",
             "dataset_versions"],
}


def export_state(db: Database, path: Path, max_runs: int = 500) -> dict[str, int]:
    out: dict[str, Any] = {"version": STATE_VERSION}
    counts: dict[str, int] = {}
    for table, cols in TABLES.items():
        q = f"SELECT {', '.join(cols)} FROM {table}"
        if table == "runs":
            q += f" ORDER BY started_at DESC LIMIT {int(max_runs)}"
        else:
            q += f" ORDER BY {cols[0]}"
        rows = [dict(r) for r in db.conn.execute(q)]
        out[table] = rows
        counts[table] = len(rows)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
    tmp.replace(path)
    return counts


def import_state(db: Database, path: Path) -> dict[str, int]:
    """Fusiona el estado guardado con la base local (las filas guardadas prevalecen)."""
    if not path.is_file():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("version") != STATE_VERSION:
        raise ValueError(f"{path}: versión de estado {data.get('version')} no soportada")
    counts: dict[str, int] = {}
    with db.transaction() as conn:
        for table, cols in TABLES.items():
            rows = data.get(table) or []
            placeholders = ",".join("?" * len(cols))
            conn.executemany(
                f"INSERT OR REPLACE INTO {table}({', '.join(cols)}) VALUES({placeholders})",
                [tuple(r.get(c) for c in cols) for r in rows],
            )
            counts[table] = len(rows)
    return counts
