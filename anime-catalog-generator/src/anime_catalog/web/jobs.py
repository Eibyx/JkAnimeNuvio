"""Gestor de trabajos en segundo plano para la interfaz web.

- Cada trabajo se ejecuta en un hilo propio con su propio contexto (conexión SQLite incluida), así el
  servidor web nunca se bloquea mientras se procesa un catálogo.
- El progreso es real: fase, procesados, total (solo si se conoce), velocidad, tiempo, errores y
  títulos pendientes. Nunca se calcula un porcentaje sin total conocido.
- Cancelación cooperativa en puntos seguros (ver catalog/progress.py).
- Bloqueo por lista: dos trabajos de escritura no pueden tocar la misma lista a la vez.
- El estado se guarda en la tabla `jobs`; si el proceso muere, al reiniciar los trabajos que estaban
  en marcha aparecen como «interrumpido» y pueden reintentarse (la sincronización es idempotente).
"""

from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from collections import deque
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

from ..catalog.progress import Cancelled, Progress
from ..storage.database import Database

log = logging.getLogger(__name__)

ACTIVE = ("queued", "running")


class JobConflict(RuntimeError):
    """Ya hay un trabajo activo sobre la misma lista."""


@dataclass
class Job:
    id: str
    kind: str
    title: str
    params: dict[str, Any]
    list_key: str | None = None
    status: str = "queued"  # queued | running | done | failed | cancelled | interrupted
    phase: str = "En cola"
    phase_started: float = 0.0
    processed: int = 0
    total: int | None = None
    phase_history: list[dict[str, Any]] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    errors: list[str] = field(default_factory=list)
    pending: list[str] = field(default_factory=list)
    log: deque[str] = field(default_factory=lambda: deque(maxlen=200))
    last_item: str | None = None
    result: dict[str, Any] | None = None
    seq: int = 0
    cancel_event: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            now = time.time()
            elapsed = ((self.finished_at or now) - self.started_at) if self.started_at else 0.0
            phase_elapsed = max(1e-6, (self.finished_at or now) - self.phase_started) if self.phase_started else 0.0
            rate = round(self.processed / phase_elapsed, 2) if self.processed and phase_elapsed else None
            percent = None
            if self.total:  # solo con total conocido
                percent = round(min(100.0, 100.0 * self.processed / self.total), 1)
            return {
                "id": self.id, "kind": self.kind, "title": self.title, "status": self.status, "phase": self.phase,
                "processed": self.processed, "total": self.total, "percent": percent, "rate_per_s": rate,
                "elapsed_s": round(elapsed, 1), "created_at": self.created_at, "started_at": self.started_at,
                "finished_at": self.finished_at, "errors": self.errors[-50:], "error_count": len(self.errors),
                "pending": self.pending[:100], "pending_count": len(self.pending), "log": list(self.log)[-30:],
                "last_item": self.last_item, "phases": self.phase_history[-20:], "result": self.result,
                "params": self.params, "list_key": self.list_key, "seq": self.seq,
                "cancel_requested": self.cancel_event.is_set(),
            }


class JobProgress(Progress):
    """Adaptador entre el pipeline y un Job (con throttling para no saturar a los clientes SSE)."""

    def __init__(self, job: Job, manager: JobManager):
        self.job = job
        self.manager = manager
        self._last_bump = 0.0

    def _bump(self, force: bool = False) -> None:
        now = time.monotonic()
        if force or now - self._last_bump > 0.25:
            self._last_bump = now
            with self.job.lock:
                self.job.seq += 1
            self.manager.notify()

    def phase(self, name: str, total: int | None = None) -> None:
        j = self.job
        with j.lock:
            if j.phase_history and j.phase_history[-1].get("end") is None:
                j.phase_history[-1]["end"] = time.time()
                j.phase_history[-1]["processed"] = j.processed
            j.phase, j.total, j.processed = name, total, 0
            j.phase_started = time.time()
            j.phase_history.append({"name": name, "start": j.phase_started, "end": None, "total": total})
            j.log.append(f"{time.strftime('%H:%M:%S')} {name}")
        self._bump(force=True)

    def set_total(self, total: int | None) -> None:
        with self.job.lock:
            self.job.total = total
        self._bump()

    def advance(self, n: int = 1, item: str | None = None) -> None:
        with self.job.lock:
            self.job.processed += n
            if item:
                self.job.last_item = item
        self._bump()

    def error(self, message: str) -> None:
        with self.job.lock:
            self.job.errors.append(message)
        self._bump(force=True)

    def pending(self, items: list[str]) -> None:
        with self.job.lock:
            self.job.pending = list(items)
        self._bump(force=True)

    def log(self, message: str) -> None:
        with self.job.lock:
            self.job.log.append(f"{time.strftime('%H:%M:%S')} {message}")
        self._bump()

    def check(self) -> None:
        if self.job.cancel_event.is_set():
            raise Cancelled()


Runner = Callable[[Job, JobProgress], dict[str, Any]]


class JobManager:
    def __init__(self, db_path: str, max_workers: int = 2):
        self.db_path = db_path
        self.jobs: dict[str, Job] = {}
        self.pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="job")
        self._lock = threading.Lock()
        self._cond = threading.Condition()
        self._db_lock = threading.Lock()
        self._db = Database(db_path, check_same_thread=False)  # protegido por _db_lock
        self._recover()

    # ------------------------------------------------------------------ persistencia
    def _recover(self) -> None:
        """Los trabajos que quedaron activos en una ejecución anterior pasan a «interrumpido»."""
        with self._db_lock:
            rows = self._db.conn.execute("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100").fetchall()
            for r in rows:
                snap = json.loads(r["snapshot"] or "{}")
                status = r["status"]
                if status in ACTIVE:
                    status = "interrupted"
                    self._db.conn.execute("UPDATE jobs SET status=? WHERE job_id=?", (status, r["job_id"]))
                job = Job(id=r["job_id"], kind=r["kind"], title=r["title"] or "", params=json.loads(r["params"] or "{}"),
                          list_key=r["list_key"], status=status, created_at=r["created_at"])
                job.phase = snap.get("phase") or job.phase
                job.processed = snap.get("processed") or 0
                job.total = snap.get("total")
                job.started_at = snap.get("started_at")
                job.finished_at = snap.get("finished_at") or (r["updated_at"] if status == "interrupted" else None)
                job.errors = list(snap.get("errors") or [])
                job.result = snap.get("result")
                if status == "interrupted":
                    job.errors.append("el servidor se detuvo durante el trabajo; puedes reintentarlo sin riesgo de duplicados")
                self.jobs[job.id] = job

    def _persist(self, job: Job) -> None:
        snap = job.snapshot()
        snap.pop("params", None)
        with self._db_lock:
            self._db.conn.execute(
                """INSERT INTO jobs(job_id, kind, title, status, params, snapshot, list_key, created_at, updated_at)
                   VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET status=excluded.status,
                   snapshot=excluded.snapshot, updated_at=excluded.updated_at""",
                (job.id, job.kind, job.title, job.status, json.dumps(job.params, ensure_ascii=False, default=str),
                 json.dumps(snap, ensure_ascii=False, default=str), job.list_key, job.created_at, time.time()),
            )

    # ------------------------------------------------------------------ ciclo de vida
    def notify(self) -> None:
        with self._cond:
            self._cond.notify_all()

    def wait_for_change(self, job_id: str, last_seq: int, timeout: float = 15.0) -> int:
        """Bloquea (en un hilo del pool del servidor) hasta que el trabajo cambie o venza el tiempo."""
        deadline = time.monotonic() + timeout
        with self._cond:
            while True:
                job = self.jobs.get(job_id)
                if job is None or job.seq != last_seq or job.status not in ACTIVE:
                    return job.seq if job else -1
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return last_seq
                self._cond.wait(min(remaining, 1.0))

    def submit(self, kind: str, title: str, params: dict[str, Any], runner: Runner, list_key: str | None = None) -> Job:
        with self._lock:
            if list_key:
                busy = [j for j in self.jobs.values() if j.list_key == list_key and j.status in ACTIVE]
                if busy:
                    raise JobConflict(f"Ya hay un trabajo en curso sobre la lista {list_key!r} ({busy[0].id}); espera o cancélalo.")
            job = Job(id=uuid.uuid4().hex[:12], kind=kind, title=title, params=params, list_key=list_key)
            self.jobs[job.id] = job
        self._persist(job)
        self.pool.submit(self._run, job, runner)
        self.notify()
        return job

    def _run(self, job: Job, runner: Runner) -> None:
        progress = JobProgress(job, self)
        with job.lock:
            job.status = "running"
            job.started_at = time.time()
        self._persist(job)
        try:
            if job.cancel_event.is_set():
                raise Cancelled()
            result = runner(job, progress)
            with job.lock:
                job.result = result
                job.status = "cancelled" if (result or {}).get("cancelled") else "done"
        except Cancelled:
            with job.lock:
                job.status = "cancelled"
                job.errors.append("cancelado por el usuario")
        except Exception as err:  # el error se muestra en la interfaz
            log.exception("Trabajo %s falló", job.id)
            with job.lock:
                job.status = "failed"
                job.errors.append(f"{type(err).__name__}: {err}")
        finally:
            with job.lock:
                job.finished_at = time.time()
                if job.phase_history and job.phase_history[-1].get("end") is None:
                    job.phase_history[-1]["end"] = job.finished_at
                    job.phase_history[-1]["processed"] = job.processed
                job.phase = {"done": "Completado", "cancelled": "Cancelado", "failed": "Error"}.get(job.status, job.phase)
                job.seq += 1
            self._persist(job)
            self.notify()

    def cancel(self, job_id: str) -> Job | None:
        job = self.jobs.get(job_id)
        if job is None:
            return None
        job.cancel_event.set()
        with job.lock:
            job.log.append(f"{time.strftime('%H:%M:%S')} cancelación solicitada (se detendrá en un punto seguro)")
            job.seq += 1
        self.notify()
        return job

    def get(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)

    def list(self, limit: int = 50) -> list[Job]:
        return sorted(self.jobs.values(), key=lambda j: j.created_at, reverse=True)[:limit]

    def active(self) -> list[Job]:
        return [j for j in self.jobs.values() if j.status in ACTIVE]

    def shutdown(self) -> None:
        if getattr(self, "_closed", False):
            return
        self._closed = True
        for j in self.active():
            j.cancel_event.set()
        self.pool.shutdown(wait=False, cancel_futures=True)
