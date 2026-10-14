"""Motor de sincronización con MDBList: calcula diferencias antes de escribir y nunca borra sin permiso.

Modos:
- create:  crea la lista; si ya existe, error salvo `reuse_existing: true` (entonces se comporta como append).
- append:  solo añade lo que falta. Nunca elimina. (Predeterminado.)
- sync:    añade lo que falta y, SOLO con `allow_removals`, quita elementos que esta aplicación añadió
           antes (conjunto gestionado) y que ya no cumplen los filtros. Lo añadido a mano se respeta.
- replace: deja la lista exactamente igual al catálogo; requiere confirmación explícita y muestra
           antes la vista previa de eliminaciones.
- dry-run: cualquier modo sin escribir nada (ni siquiera crear la lista).

Idempotencia y reanudación: cada ejecución vuelve a leer la lista real y calcula la diferencia, por lo
que repetir una ejecución interrumpida no duplica elementos. Cada lote se registra en `sync_items`.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any

from ..config import MDBListConfig, SyncMode
from ..models import ResolvedTitle
from ..storage.database import Database
from ..catalog.progress import NULL_PROGRESS, Cancelled, Progress
from .mdblist import Identity, MDBListClient, MDBListError

log = logging.getLogger(__name__)


class SyncError(RuntimeError):
    pass


@dataclass
class SyncPlan:
    list_name: str
    mode: SyncMode
    list_id: int | None = None
    list_exists: bool = False
    will_create: bool = False
    existing: dict[Identity, dict[str, Any]] = field(default_factory=dict)
    desired: dict[Identity, ResolvedTitle] = field(default_factory=dict)
    to_add: list[Identity] = field(default_factory=list)
    to_remove: list[Identity] = field(default_factory=list)
    already_present: list[Identity] = field(default_factory=list)
    unmanaged_kept: list[Identity] = field(default_factory=list)
    previously_managed: set[Identity] = field(default_factory=set)
    notes: list[str] = field(default_factory=list)


@dataclass
class SyncResult:
    applied: bool
    list_id: int | None = None
    created: bool = False
    added: list[Identity] = field(default_factory=list)
    removed: list[Identity] = field(default_factory=list)
    reported_existing: int = 0  # elementos que MDBList ya tenía al recibir el lote
    not_found: list[Identity] = field(default_factory=list)
    failed: list[Identity] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    interrupted: bool = False
    cancelled: bool = False


class SyncEngine:
    def __init__(self, db: Database, config: MDBListConfig, client: MDBListClient | None, *, catalog: str, run_id: str):
        self.db = db
        self.config = config
        self.client = client
        self.catalog = catalog
        self.run_id = run_id

    # ------------------------------------------------------------------ lista destino
    def _locate_list(self, name: str, dry_run: bool) -> tuple[int | None, bool, list[str]]:
        notes: list[str] = []
        if self.client is None:
            notes.append("sin MDBLIST_API_KEY: no se consulta la lista real (se asume vacía)")
            return None, False, notes
        if self.config.list_id:
            info = self.client.get_list(self.config.list_id)
            if not info:
                raise SyncError(f"La lista con id {self.config.list_id} no existe o no es accesible")
            if info.get("name") and info["name"] != name:
                notes.append(f"la lista {self.config.list_id} se llama {info['name']!r} (no {name!r}); se usa por id")
            return int(self.config.list_id), True, notes
        matches = self.client.find_lists(name)
        if len(matches) > 1:
            ids = [m.get("id") for m in matches]
            raise SyncError(
                f"Hay {len(matches)} listas llamadas {name!r} en MDBList (ids {ids}). No se elige una al azar: "
                "indica `mdblist.list_id` en el YAML o `--list-id`."
            )
        if matches:
            if self.config.mode == SyncMode.CREATE and not self.config.reuse_existing:
                raise SyncError(
                    f"La lista {name!r} ya existe (id {matches[0].get('id')}). Usa --mode append/sync o "
                    "`mdblist.reuse_existing: true` para reutilizarla."
                )
            return int(matches[0]["id"]), True, notes
        if not (self.config.create_if_missing or self.config.mode == SyncMode.CREATE):
            raise SyncError(f"La lista {name!r} no existe y create_if_missing=false")
        return None, False, notes

    # ------------------------------------------------------------------ plan
    def plan(self, name: str, desired_titles: list[ResolvedTitle], dry_run: bool) -> SyncPlan:
        plan = SyncPlan(list_name=name, mode=self.config.mode)
        list_id, exists, notes = self._locate_list(name, dry_run)
        plan.list_id, plan.list_exists, plan.notes = list_id, exists, notes
        plan.will_create = not exists
        for t in desired_titles:
            if t.identity:
                plan.desired.setdefault(t.identity, t)  # type: ignore[arg-type]
        if exists and self.client is not None and list_id is not None:
            plan.existing = self.client.list_items(list_id)
            plan.previously_managed = self._managed(list_id)
        desired = set(plan.desired)
        existing = set(plan.existing)
        # Se conserva el orden del catálogo (orden configurado en los filtros).
        plan.to_add = [i for i in plan.desired if i not in existing]
        plan.already_present = [i for i in plan.desired if i in existing]
        extra = existing - desired
        if self.config.mode == SyncMode.SYNC:
            if self.config.allow_removals:
                plan.to_remove = sorted(extra & plan.previously_managed)
                plan.unmanaged_kept = sorted(extra - plan.previously_managed)
            else:
                plan.unmanaged_kept = sorted(extra)
                if extra & plan.previously_managed:
                    plan.notes.append(
                        f"{len(extra & plan.previously_managed)} elemento(s) gestionados ya no cumplen los filtros; "
                        "no se eliminan porque allow_removals=false"
                    )
        elif self.config.mode == SyncMode.REPLACE:
            plan.to_remove = sorted(extra)
        else:
            plan.unmanaged_kept = sorted(extra)
        return plan

    def _managed(self, list_id: int) -> set[Identity]:
        rows = self.db.conn.execute("SELECT media_type, tmdb_id FROM managed_items WHERE list_id=?", (list_id,))
        return {(r[0], int(r[1])) for r in rows}

    # ------------------------------------------------------------------ aplicar
    def apply(self, plan: SyncPlan, *, confirm_replace: bool = False, private: bool = False,
              progress: Progress | None = None) -> SyncResult:
        pr = progress or NULL_PROGRESS
        if self.client is None:
            raise SyncError("Se necesita MDBLIST_API_KEY para escribir en MDBList")
        if plan.mode == SyncMode.REPLACE and plan.to_remove and not confirm_replace:
            raise SyncError(
                f"El modo replace eliminaría {len(plan.to_remove)} elemento(s). Revisa la vista previa y repite con --confirm-replace."
            )
        res = SyncResult(applied=True, list_id=plan.list_id)
        if plan.list_id is None:
            created = self.client.create_list(plan.list_name, private=private)
            plan.list_id = int(created["id"])
            res.list_id = plan.list_id
            res.created = True
            log.info("Lista %r creada en MDBList (id %s)", plan.list_name, plan.list_id)
        list_id = plan.list_id
        assert list_id is not None
        self._journal(list_id, "add", plan.to_add)
        self._journal(list_id, "remove", plan.to_remove)
        try:
            for batch in self._batches(plan.to_remove):
                pr.check()  # punto seguro: nunca a mitad de un lote
                r = self.client.modify(list_id, "remove", batch)
                res.removed += batch
                self._mark(batch, "remove", "done")
                self.db.conn.executemany(
                    "DELETE FROM managed_items WHERE list_id=? AND media_type=? AND tmdb_id=?",
                    [(list_id, m, t) for m, t in batch],
                )
                log.info("MDBList: eliminados %d (respuesta %s)", len(batch), {k: v for k, v in r.items() if k != "raw"})
                pr.advance(len(batch))
            for batch in self._batches(plan.to_add):
                pr.check()
                r = self.client.modify(list_id, "add", batch)
                not_found = set(r.get("not_found_ids") or [])
                if r.get("not_found") and not not_found:
                    # La API solo devolvió recuentos: se relee la lista para saber cuáles no entraron.
                    present = set(self.client.list_items(list_id))
                    not_found = {b for b in batch if b not in present}
                    log.warning("MDBList: %d elemento(s) no encontrados por MDBList: %s", len(not_found), sorted(not_found)[:10])
                ok = [b for b in batch if b not in not_found]
                res.not_found += sorted(not_found)
                self._mark(sorted(not_found), "add", "not_found")
                self._mark(ok, "add", "done")
                res.added += ok
                res.reported_existing += int(r.get("existing") or 0)
                self._remember(list_id, ok, plan)
                total = r.get("added", 0) + r.get("existing", 0) + r.get("not_found", 0)
                if total and total < len(batch):
                    res.errors.append(f"respuesta parcial: {total} de {len(batch)} elementos reconocidos en un lote")
                log.info("MDBList: lote de %d enviado (añadidos %s, existentes %s, no encontrados %s)",
                         len(batch), r.get("added"), r.get("existing"), r.get("not_found"))
                pr.advance(len(batch))
                for nf in sorted(not_found):
                    pr.error(f"MDBList no encontró {nf[0]}:{nf[1]}")
        except Cancelled:
            res.interrupted = res.cancelled = True
            res.errors.append("cancelado por el usuario entre lotes; lo pendiente se añadirá en la próxima ejecución")
            res.failed = self._pending()
        except MDBListError as err:
            res.interrupted = True
            res.errors.append(str(err))
            res.failed = self._pending()
            log.error("Sincronización interrumpida: %s. Pendientes: %d (se reanudarán sin duplicados en la próxima ejecución)", err, len(res.failed))
        return res

    def _pending(self) -> list[Identity]:
        rows = self.db.conn.execute(
            "SELECT media_type, tmdb_id FROM sync_items WHERE run_id=? AND status='pending'", (self.run_id,)
        ).fetchall()
        return [(r[0], int(r[1])) for r in rows]

    def _batches(self, items: list[Identity]) -> list[list[Identity]]:
        size = self.config.batch_size
        shows = [i for i in items if i[0] == "tv"]
        movies = [i for i in items if i[0] == "movie"]
        out = []
        for group in (shows, movies):
            out += [group[i : i + size] for i in range(0, len(group), size)]
        return out

    def _journal(self, list_id: int, action: str, items: list[Identity]) -> None:
        now = time.time()
        self.db.conn.executemany(
            """INSERT INTO sync_items(run_id, list_id, media_type, tmdb_id, action, status, error, updated_at)
               VALUES(?,?,?,?,?,'pending',NULL,?) ON CONFLICT(run_id, media_type, tmdb_id, action)
               DO UPDATE SET status='pending', updated_at=excluded.updated_at""",
            [(self.run_id, list_id, m, t, action, now) for m, t in items],
        )

    def _mark(self, items: list[Identity], action: str, status: str) -> None:
        now = time.time()
        self.db.conn.executemany(
            "UPDATE sync_items SET status=?, updated_at=? WHERE run_id=? AND media_type=? AND tmdb_id=? AND action=?",
            [(status, now, self.run_id, m, t, action) for m, t in items],
        )

    def _remember(self, list_id: int, items: list[Identity], plan: SyncPlan) -> None:
        self.db.conn.executemany(
            """INSERT INTO managed_items(list_id, media_type, tmdb_id, catalog, title, first_run, last_run)
               VALUES(?,?,?,?,?,?,?) ON CONFLICT(list_id, media_type, tmdb_id)
               DO UPDATE SET last_run=excluded.last_run, catalog=excluded.catalog""",
            [(list_id, m, t, self.catalog, plan.desired[(m, t)].title if (m, t) in plan.desired else None, self.run_id, self.run_id)
             for m, t in items],
        )

    def touch_managed(self, plan: SyncPlan) -> None:
        """Marca como vistos en esta ejecución los elementos gestionados que siguen en el catálogo."""
        if plan.list_id is None:
            return
        keep = [i for i in plan.already_present if i in plan.previously_managed]
        self.db.conn.executemany(
            "UPDATE managed_items SET last_run=? WHERE list_id=? AND media_type=? AND tmdb_id=?",
            [(self.run_id, plan.list_id, m, t) for m, t in keep],
        )
