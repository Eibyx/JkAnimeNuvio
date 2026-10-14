"""Infraestructura común de datasets de mappings: descarga condicional, validación, índice y rollback."""

from __future__ import annotations

import hashlib
import logging
import os
import shutil
import time
from abc import ABC, abstractmethod
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path

import httpx

from ..http import HttpClient, HttpError
from ..storage.database import Database

log = logging.getLogger(__name__)

# Fila del índice: (src_provider, src_id, src_scope, dst_provider, dst_id, dst_scope, detail)
IndexRow = tuple[str, str, str | None, str, str, str | None, str | None]


class DatasetError(RuntimeError):
    pass


@dataclass
class UpdateResult:
    source: str
    status: str  # updated | unchanged | failed | skipped | rolled_back
    version: str | None = None
    rows: int = 0
    message: str = ""


class MappingDataset(ABC):
    """Un dataset de mappings publicado (release o archivo en un repositorio)."""

    name: str = ""
    url: str = ""
    filename: str = ""
    license: str = ""
    homepage: str = ""
    # Procedencia de los datos: sirve para no contar como independientes confirmaciones
    # que provienen del mismo origen.
    lineage: frozenset[str] = frozenset()
    base_confidence: float = 0.85
    enabled_by_default: bool = True

    def __init__(self, datasets_dir: Path):
        self.dir = Path(datasets_dir) / self.name

    @property
    def path(self) -> Path:
        return self.dir / self.filename

    @property
    def previous_path(self) -> Path:
        return self.dir / (self.filename + ".prev")

    # ---- a implementar
    @abstractmethod
    def parse(self, path: Path) -> Iterator[IndexRow]:
        """Valida y convierte el archivo en filas de índice. Debe lanzar DatasetError si el esquema no es el esperado."""

    def version_of(self, path: Path) -> str | None:
        return None

    def min_rows(self) -> int:
        return 1000

    # ---- descarga
    def download(self, http: HttpClient, db: Database, force: bool = False) -> tuple[bool, dict[str, str | None]]:
        """Descarga condicional (ETag/Last-Modified). Devuelve (cambió, metadatos)."""
        self.dir.mkdir(parents=True, exist_ok=True)
        row = db.conn.execute("SELECT etag, last_modified FROM datasets WHERE source=?", (self.name,)).fetchone()
        headers: dict[str, str] = {}
        if row and not force and self.path.exists():
            if row["etag"]:
                headers["If-None-Match"] = row["etag"]
            if row["last_modified"]:
                headers["If-Modified-Since"] = row["last_modified"]
        tmp = self.dir / (self.filename + ".download")
        sha = hashlib.sha256()
        try:
            with http.client.stream("GET", self.url, headers=headers) as resp:
                if resp.status_code == 304:
                    return False, {"etag": row["etag"] if row else None, "last_modified": row["last_modified"] if row else None}
                if resp.status_code != 200:
                    raise DatasetError(f"{self.name}: HTTP {resp.status_code} al descargar {self.url}")
                expected = resp.headers.get("Content-Length")
                size = 0
                with tmp.open("wb") as fh:
                    for chunk in resp.iter_bytes(1 << 20):
                        fh.write(chunk)
                        sha.update(chunk)
                        size += len(chunk)
                if expected and expected.isdigit() and int(expected) != size and not resp.headers.get("Content-Encoding"):
                    raise DatasetError(f"{self.name}: descarga incompleta ({size} de {expected} bytes)")
                meta = {
                    "etag": resp.headers.get("ETag"),
                    "last_modified": resp.headers.get("Last-Modified"),
                    "sha256": sha.hexdigest(),
                }
        except (httpx.HTTPError, HttpError) as err:
            tmp.unlink(missing_ok=True)
            raise DatasetError(f"{self.name}: error de red: {err}") from err
        old = db.conn.execute("SELECT sha256 FROM datasets WHERE source=?", (self.name,)).fetchone()
        if old and old["sha256"] == meta["sha256"] and self.path.exists() and not force:
            tmp.unlink(missing_ok=True)
            return False, meta
        return True, {**meta, "tmp": str(tmp)}

    # ---- índice
    def install(self, db: Database, new_file: Path, meta: dict[str, str | None]) -> UpdateResult:
        """Valida el archivo nuevo; si es correcto, rota el anterior a .prev y reconstruye el índice."""
        try:
            rows = list(self.parse(new_file))
        except DatasetError as err:
            new_file.unlink(missing_ok=True)
            self._set_status(db, "failed", str(err))
            return UpdateResult(self.name, "failed", message=f"esquema no válido; se conserva la versión anterior: {err}")
        except Exception as err:  # archivo corrupto, JSON inválido, etc.
            new_file.unlink(missing_ok=True)
            self._set_status(db, "failed", repr(err))
            return UpdateResult(self.name, "failed", message=f"no se pudo leer el dataset; se conserva la versión anterior: {err!r}")
        if len(rows) < self.min_rows():
            new_file.unlink(missing_ok=True)
            msg = f"solo {len(rows)} filas (< {self.min_rows()}); se conserva la versión anterior"
            self._set_status(db, "failed", msg)
            return UpdateResult(self.name, "failed", message=msg)
        version = self.version_of(new_file) or (meta.get("sha256") or "")[:12]
        prev_version = None
        old = db.conn.execute("SELECT version FROM datasets WHERE source=?", (self.name,)).fetchone()
        if old:
            prev_version = old["version"]
        if new_file != self.path:
            if self.path.exists():
                shutil.copy2(self.path, self.previous_path)
            os.replace(new_file, self.path)
        self._write_index(db, rows)
        db.conn.execute(
            """INSERT INTO datasets(source, version, etag, last_modified, sha256, path, previous_path, previous_version,
               downloaded_at, indexed_at, rows, status, message) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(source) DO UPDATE SET version=excluded.version, etag=excluded.etag,
               last_modified=excluded.last_modified, sha256=excluded.sha256, path=excluded.path,
               previous_path=excluded.previous_path, previous_version=excluded.previous_version,
               downloaded_at=excluded.downloaded_at, indexed_at=excluded.indexed_at, rows=excluded.rows,
               status=excluded.status, message=excluded.message""",
            (
                self.name, version, meta.get("etag"), meta.get("last_modified"), meta.get("sha256"),
                str(self.path), str(self.previous_path) if self.previous_path.exists() else None, prev_version,
                time.time(), time.time(), len(rows), "ok", None,
            ),
        )
        return UpdateResult(self.name, "updated", version=version, rows=len(rows))

    def _write_index(self, db: Database, rows: Iterable[IndexRow]) -> None:
        with db.transaction() as conn:
            conn.execute("DELETE FROM mapping_index WHERE source=?", (self.name,))
            conn.executemany(
                "INSERT INTO mapping_index(source, src_provider, src_id, src_scope, dst_provider, dst_id, dst_scope, detail) "
                "VALUES(?,?,?,?,?,?,?,?)",
                ((self.name, *r) for r in rows),
            )

    def _set_status(self, db: Database, status: str, message: str) -> None:
        db.conn.execute(
            """INSERT INTO datasets(source, status, message) VALUES(?,?,?)
               ON CONFLICT(source) DO UPDATE SET status=excluded.status, message=excluded.message""",
            (self.name, status, message[:500]),
        )

    def update(self, http: HttpClient, db: Database, force: bool = False) -> UpdateResult:
        try:
            changed, meta = self.download(http, db, force=force)
        except DatasetError as err:
            self._set_status(db, "failed", str(err))
            return UpdateResult(self.name, "failed", message=str(err))
        if not changed:
            indexed = db.conn.execute("SELECT COUNT(*) FROM mapping_index WHERE source=?", (self.name,)).fetchone()[0]
            if indexed == 0 and self.path.exists():
                return self.install(db, self.path, meta)
            row = db.conn.execute("SELECT version, rows FROM datasets WHERE source=?", (self.name,)).fetchone()
            return UpdateResult(self.name, "unchanged", version=row["version"] if row else None, rows=row["rows"] if row else 0)
        return self.install(db, Path(meta["tmp"]), meta)  # type: ignore[arg-type]

    def rollback(self, db: Database) -> UpdateResult:
        if not self.previous_path.exists():
            return UpdateResult(self.name, "failed", message="no hay una versión anterior guardada")
        current = self.dir / (self.filename + ".rollback")
        if self.path.exists():
            shutil.copy2(self.path, current)
        shutil.copy2(self.previous_path, self.path)
        sha = hashlib.sha256(self.path.read_bytes()).hexdigest()
        res = self.install(db, self.path, {"sha256": sha, "etag": None, "last_modified": None})
        if current.exists():
            os.replace(current, self.previous_path)
        if res.status == "updated":
            res.status = "rolled_back"
        return res


def split_ids(value: object) -> list[str]:
    """Kometa usa cadenas separadas por comas para campos con varios IDs."""
    if value is None or value == "":
        return []
    if isinstance(value, (list, tuple)):
        out: list[str] = []
        for v in value:
            out += split_ids(v)
        return out
    return [p.strip() for p in str(value).split(",") if p.strip()]
