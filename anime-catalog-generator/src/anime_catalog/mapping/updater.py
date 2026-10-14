"""Actualización de datasets de mappings: descarga condicional, validación, índice, rollback.

Los overrides manuales viven en la tabla `overrides` (y opcionalmente en overrides.yaml), nunca en los
datasets, así que actualizar o revertir un dataset no los toca.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import httpx

from ..http import HttpClient
from ..storage.database import Database
from .base import MappingDataset, UpdateResult
from .index import DATASET_CLASSES

log = logging.getLogger(__name__)

DEFAULT_SOURCES = [name for name, cls in DATASET_CLASSES.items() if cls.enabled_by_default]


class MappingUpdater:
    def __init__(self, db: Database, datasets_dir: Path, *, transport: httpx.BaseTransport | None = None, timeout: float = 300.0,
                 sleep: Any = None):
        self.db = db
        self.datasets_dir = Path(datasets_dir)
        kwargs: dict[str, Any] = {"sleep": sleep} if sleep is not None else {}
        self.http = HttpClient("", timeout=timeout, transport=transport, name="datasets", headers={"Accept": "*/*"}, **kwargs)

    def close(self) -> None:
        self.http.close()

    def dataset(self, name: str) -> MappingDataset:
        if name not in DATASET_CLASSES:
            raise ValueError(f"Fuente de mappings desconocida: {name}. Disponibles: {sorted(DATASET_CLASSES)}")
        return DATASET_CLASSES[name](self.datasets_dir)

    def update(self, sources: list[str] | None = None, force: bool = False) -> list[UpdateResult]:
        results = []
        for name in sources or DEFAULT_SOURCES:
            ds = self.dataset(name)
            log.info("Actualizando mappings de %s desde %s", name, ds.url)
            res = ds.update(self.http, self.db, force=force)
            log.info("%s: %s %s %s", name, res.status, res.version or "", res.message)
            results.append(res)
        return results

    def rollback(self, source: str) -> UpdateResult:
        return self.dataset(source).rollback(self.db)

    def ensure(self, sources: list[str]) -> list[UpdateResult]:
        """Descarga las fuentes que todavía no tienen índice local."""
        missing = [s for s in sources if s in DATASET_CLASSES and not self._indexed(s)]
        return self.update(missing) if missing else []

    def _indexed(self, source: str) -> bool:
        return self.db.conn.execute("SELECT 1 FROM mapping_index WHERE source=? LIMIT 1", (source,)).fetchone() is not None

    def status(self) -> list[dict[str, Any]]:
        rows = {r["source"]: dict(r) for r in self.db.conn.execute("SELECT * FROM datasets")}
        out = []
        for name, cls in DATASET_CLASSES.items():
            r = rows.get(name, {})
            out.append({
                "source": name,
                "enabled_by_default": cls.enabled_by_default,
                "license": cls.license,
                "url": cls.url,
                "version": r.get("version"),
                "rows": r.get("rows"),
                "status": r.get("status") or "no descargado",
                "previous_version": r.get("previous_version"),
                "message": r.get("message"),
                "downloaded_at": r.get("downloaded_at"),
            })
        return out
