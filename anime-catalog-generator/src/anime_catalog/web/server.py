"""Servidor web local (FastAPI) de Anime Catalog Generator.

Arranque: `anime-catalog ui` -> http://127.0.0.1:8765 (solo loopback por defecto).
Las claves de MDBList/TMDB nunca salen del backend: la API solo informa de si están configuradas.
"""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
import logging
from importlib import resources
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from .. import __version__
from ..config import SECRET_ENV_KEYS, Settings, save_secrets
from ..context import Transports
from ..platform import platform_info
from .jobs import JobConflict, JobManager
from .security import SecurityConfig, SecurityMiddleware
from .services import ServiceError, Services

log = logging.getLogger(__name__)
STATIC_DIR = Path(str(resources.files("anime_catalog.web").joinpath("static")))
TERMINAL = ("done", "failed", "cancelled", "interrupted")


def create_app(settings: Settings, *, security: SecurityConfig | None = None, transports: Transports | None = None,
               max_workers: int = 2) -> FastAPI:
    security = security or SecurityConfig()
    services = Services(settings, transports)
    settings.database_path.parent.mkdir(parents=True, exist_ok=True)
    manager = JobManager(str(settings.database_path), max_workers=max_workers)

    @asynccontextmanager
    async def lifespan(_: FastAPI):  # type: ignore[no-untyped-def]
        yield
        manager.shutdown()

    app = FastAPI(title="Anime Catalog Generator", version=__version__, docs_url=None, redoc_url=None, openapi_url=None,
                  lifespan=lifespan)
    app.state.services = services
    app.state.jobs = manager
    app.state.security = security
    app.add_middleware(SecurityMiddleware, config=security)
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    @app.exception_handler(ServiceError)
    async def _service_error(_: Request, err: ServiceError) -> JSONResponse:
        return JSONResponse({"detail": str(err)}, status_code=err.status)

    @app.exception_handler(JobConflict)
    async def _conflict(_: Request, err: JobConflict) -> JSONResponse:
        return JSONResponse({"detail": str(err)}, status_code=409)

    # ------------------------------------------------------------------ página
    index_template = (STATIC_DIR / "index.html").read_text(encoding="utf-8")

    @app.get("/", response_class=HTMLResponse)
    def index() -> HTMLResponse:
        html = index_template.replace("{{CSRF_TOKEN}}", security.csrf_token).replace("{{VERSION}}", __version__)
        return HTMLResponse(html, headers={"Cache-Control": "no-store"})

    @app.get("/manifest.webmanifest")
    def manifest() -> JSONResponse:
        return JSONResponse({
            "name": "Anime Catalog Generator", "short_name": "AnimeCatalog", "start_url": "/", "display": "standalone",
            "background_color": "#0f1115", "theme_color": "#6d5efc", "lang": "es",
            "icons": [{"src": "/static/icon.svg", "sizes": "any", "type": "image/svg+xml"}],
        }, media_type="application/manifest+json")

    # ------------------------------------------------------------------ sistema
    @app.get("/api/status")
    def status() -> dict[str, Any]:
        s = services.settings
        return {"version": __version__, "settings": s.public_summary(), "platform": platform_info(),
                "active_jobs": len(manager.active())}

    @app.get("/api/dashboard")
    def dashboard() -> dict[str, Any]:
        return services.dashboard([j.snapshot() for j in manager.list(20)])

    @app.get("/api/settings")
    def get_settings() -> dict[str, Any]:
        return {**services.settings.public_summary(), "keys": {k: bool(_env_has(k)) for k in SECRET_ENV_KEYS}}

    @app.post("/api/settings/keys")
    def set_keys(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        values = {k: (str(v) if v is not None else "") for k, v in body.items() if k in SECRET_ENV_KEYS}
        if not values:
            raise ServiceError("No se indicó ninguna clave válida")
        save_secrets(services.settings.env_file, values)
        services.reload_settings()
        # Solo se devuelve si cada clave está configurada, nunca su valor.
        return {"ok": True, "keys": {k: bool(_env_has(k)) for k in SECRET_ENV_KEYS}}

    # ------------------------------------------------------------------ catálogo
    @app.get("/api/options")
    def options() -> dict[str, Any]:
        return services.options()

    @app.get("/api/studios")
    def studios(q: str = "") -> list[dict[str, Any]]:
        return services.studios(q)

    @app.post("/api/config/validate")
    def validate(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        cfg = services.validate(_config_from_body(body))
        return {"ok": True, "config": json.loads(cfg.model_dump_json(by_alias=True)), "yaml": services.to_yaml(cfg)}

    @app.post("/api/config/from-yaml")
    def from_yaml(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        cfg = services.from_yaml(str(body.get("yaml") or ""))
        return {"ok": True, "config": json.loads(cfg.model_dump_json(by_alias=True))}

    @app.get("/api/profiles")
    def profiles() -> list[dict[str, Any]]:
        return services.list_profiles()

    @app.get("/api/profiles/{name}")
    def get_profile(name: str) -> dict[str, Any]:
        return services.load_profile(name)

    @app.put("/api/profiles/{name}")
    def put_profile(name: str, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        return services.save_profile(name, body.get("config") or {})

    @app.delete("/api/profiles/{name}")
    def delete_profile(name: str) -> dict[str, Any]:
        return {"deleted": services.delete_profile(name)}

    # ------------------------------------------------------------------ trabajos
    @app.post("/api/jobs/catalog")
    def start_catalog(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        cfg = services.validate(_config_from_body(body))
        apply = bool(body.get("apply"))
        confirm_replace = bool(body.get("confirm_replace"))
        if apply:
            if body.get("confirm") is not True:
                raise ServiceError("La escritura en MDBList requiere confirmación explícita", 428)
            if not services.settings.mdblist_api_key:
                raise ServiceError("Configura MDBLIST_API_KEY en Ajustes para sincronizar", 412)
            if cfg.mdblist.mode.value == "replace" and not confirm_replace:
                raise ServiceError("El modo replace requiere confirmar las eliminaciones (simula primero para ver la vista previa)", 428)
        title = f"{'Sincronizar' if apply else 'Simular'}: {cfg.catalog.name}"
        params = {"config": json.loads(cfg.model_dump_json(by_alias=True)), "apply": apply, "confirm_replace": confirm_replace}
        job = manager.submit(
            "catalog", title, params,
            lambda j, p: services.run_catalog(cfg, p, apply=apply, confirm_replace=confirm_replace),
            list_key=services.list_key(cfg) if apply else None,
        )
        return job.snapshot()

    @app.post("/api/jobs/datasets")
    def start_datasets(body: dict[str, Any] = Body(default={})) -> dict[str, Any]:
        sources = body.get("sources") or None
        force = bool(body.get("force"))
        job = manager.submit("datasets", "Actualizar mappings", {"sources": sources, "force": force},
                             lambda j, p: services.run_datasets(p, sources, force), list_key="datasets")
        return job.snapshot()

    @app.get("/api/jobs")
    def jobs(limit: int = 30) -> list[dict[str, Any]]:
        return [_light(j.snapshot()) for j in manager.list(limit)]

    @app.get("/api/jobs/{job_id}")
    def job(job_id: str) -> dict[str, Any]:
        return _job_or_404(manager, job_id).snapshot()

    @app.post("/api/jobs/{job_id}/cancel")
    def cancel(job_id: str) -> dict[str, Any]:
        _job_or_404(manager, job_id)
        return manager.cancel(job_id).snapshot()  # type: ignore[union-attr]

    @app.post("/api/jobs/{job_id}/retry")
    def retry(job_id: str) -> dict[str, Any]:
        old = _job_or_404(manager, job_id)
        if old.status not in TERMINAL:
            raise ServiceError("El trabajo sigue activo", 409)
        if old.kind == "datasets":
            return start_datasets(old.params)
        params = dict(old.params)
        if params.get("apply"):
            params["confirm"] = True  # ya se confirmó al lanzarlo; reintentar no duplica (diferencias)
        return start_catalog(params)

    @app.get("/api/jobs/{job_id}/events")
    async def events(job_id: str, request: Request) -> StreamingResponse:
        _job_or_404(manager, job_id)

        async def stream():  # type: ignore[no-untyped-def]
            seq = -1
            while True:
                if await request.is_disconnected():
                    break
                job = manager.get(job_id)
                if job is None:
                    break
                snap = job.snapshot()
                if snap["seq"] != seq:
                    seq = snap["seq"]
                    yield f"event: progress\ndata: {json.dumps(snap, ensure_ascii=False, default=str)}\n\n"
                if snap["status"] in TERMINAL:
                    yield "event: end\ndata: {}\n\n"
                    break
                new = await run_in_threadpool(manager.wait_for_change, job_id, seq, 10.0)
                if new == seq:
                    yield ": keep-alive\n\n"
                await asyncio.sleep(0)

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})

    @app.get("/api/jobs/{job_id}/rows")
    def job_rows(job_id: str, section: str = "titles", page: int = 1, size: int = 25, q: str = "", status: str = "") -> dict[str, Any]:
        job = _job_or_404(manager, job_id)
        report_dir = (job.result or {}).get("report_dir")
        if not report_dir:
            raise ServiceError("Este trabajo no tiene resultados", 404)
        return services.report_rows(report_dir, section, page, size, q, status)

    # ------------------------------------------------------------------ historial
    @app.get("/api/runs")
    def runs(page: int = 1, size: int = 20) -> dict[str, Any]:
        return services.runs(page, size)

    @app.get("/api/runs/{run_id}/items")
    def run_items(run_id: str, status: str = "") -> list[dict[str, Any]]:
        return services.run_items(run_id, status)

    # ------------------------------------------------------------------ explorador de mappings
    @app.get("/api/mappings/search")
    def search(by: str = "title", q: str = "", page: int = 1, size: int = 20, remote: bool = True) -> dict[str, Any]:
        return services.search(by, q, page, size, remote)

    @app.get("/api/mappings/detail")
    def detail(uid: str = Query(...)) -> dict[str, Any]:
        return services.detail(uid)

    @app.get("/api/review")
    def review(status: str = "", page: int = 1, size: int = 25) -> dict[str, Any]:
        return services.review(status, page, size)

    @app.post("/api/overrides")
    def set_override(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        return services.set_override(body)

    @app.delete("/api/overrides/{uid}")
    def delete_override(uid: str) -> dict[str, Any]:
        return {"deleted": services.delete_override(uid)}

    # ------------------------------------------------------------------ MDBList
    @app.get("/api/mdblist/lists")
    def mdb_lists() -> list[dict[str, Any]]:
        return services.mdb_lists()

    @app.post("/api/mdblist/lists")
    def mdb_create(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        if body.get("confirm") is not True:
            raise ServiceError("Crear una lista requiere confirmación explícita", 428)
        return services.mdb_create(str(body.get("name") or ""), bool(body.get("private")))

    @app.get("/api/mdblist/lists/{list_id}/items")
    def mdb_items(list_id: int, page: int = 1, size: int = 25, q: str = "", media: str = "") -> dict[str, Any]:
        return services.mdb_items(list_id, page, size, q, media)

    return app


def _config_from_body(body: dict[str, Any]) -> dict[str, Any]:
    """Configuración enviada por la interfaz; la expresión avanzada llega como texto YAML."""
    import yaml

    config = dict(body.get("config") or {})
    expr = body.get("expression_yaml")
    if isinstance(expr, str) and expr.strip():
        try:
            parsed = yaml.safe_load(expr)
        except yaml.YAMLError as err:
            raise ServiceError(f"La expresión avanzada no es YAML válido: {err}", 422) from err
        if parsed is not None and not isinstance(parsed, dict):
            raise ServiceError("La expresión avanzada debe ser un objeto (and/or/not o un bloque de filtros)", 422)
        filters = dict(config.get("filters") or {})
        filters["expression"] = parsed
        config["filters"] = filters
    return config


def _env_has(key: str) -> bool:
    import os

    return bool((os.environ.get(key) or "").strip())


def _light(snap: dict[str, Any]) -> dict[str, Any]:
    """Versión ligera para listados (sin registros ni pendientes)."""
    return {k: v for k, v in snap.items() if k not in ("log", "pending", "phases", "params")}


def _job_or_404(manager: JobManager, job_id: str):  # type: ignore[no-untyped-def]
    job = manager.get(job_id)
    if job is None:
        raise HTTPException(404, "Trabajo no encontrado")
    return job


def run(settings: Settings, *, host: str = "127.0.0.1", port: int = 8765, allow_remote: bool = False,
        access_token: str | None = None, open_browser: bool = False) -> None:  # pragma: no cover - arranque real
    import uvicorn

    from .security import is_loopback

    if not is_loopback(host) and not allow_remote:
        raise SystemExit("Escuchar fuera de 127.0.0.1 requiere --allow-remote y ANIME_CATALOG_UI_TOKEN")
    if allow_remote and not access_token:
        raise SystemExit("--allow-remote requiere un token de acceso (ANIME_CATALOG_UI_TOKEN)")
    security = SecurityConfig(host=host, port=port, allow_remote=allow_remote, access_token=access_token)
    app = create_app(settings, security=security)
    url = f"http://{'127.0.0.1' if host in ('0.0.0.0', '::') else host}:{port}"
    print(f"Anime Catalog Generator {__version__} — interfaz en {url}  (Ctrl+C para detener)", flush=True)
    if open_browser:
        try:
            import webbrowser

            webbrowser.open(url)
        except Exception:
            pass
    uvicorn.run(app, host=host, port=port, log_level="warning", access_log=False, workers=1, lifespan="on")
