"""Interfaz de línea de comandos `anime-catalog` (Typer)."""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from typing import Annotated, Any, Optional

import typer
import yaml
from rich.console import Console
from rich.table import Table

from . import __version__
from .catalog.canonical import CanonicalAnimeResolver
from .catalog.pipeline import CatalogPipeline
from .config import CatalogConfig, ConfigError, Settings, load_config, parse_config
from .context import AppContext, Transports, build_context
from .http import HttpError, redact
from .integrations.mdblist import MDBListError
from .integrations.sync import SyncError
from .mapping.resolver import MappingResolver
from .models import AnimeEntry
from .reporting.reports import print_summary, write_reports
from .storage.overrides import export_overrides, import_overrides
from .storage.state import export_state, import_state

app = typer.Typer(help="Anime Catalog Generator: catálogos de anime en MDBList desde AniList/MyAnimeList.", no_args_is_help=True,
                  add_completion=False)
mappings_app = typer.Typer(help="Gestión de los datasets de mappings (AniBridge, Kometa, Fribb, Anime-Lists).", no_args_is_help=True)
review_app = typer.Typer(help="Revisión de mappings dudosos y overrides manuales.", invoke_without_command=True)
state_app = typer.Typer(help="Estado persistente (elementos gestionados, overrides, revisión, historial).", no_args_is_help=True)
app.add_typer(mappings_app, name="mappings")
app.add_typer(review_app, name="review")
app.add_typer(state_app, name="state")

console = Console()
err_console = Console(stderr=True)

# Puntos de inyección para pruebas (transportes HTTP simulados).
TRANSPORTS: Transports | None = None


class _RedactFilter(logging.Filter):
    def __init__(self, secrets: list[str]):
        super().__init__()
        self.secrets = secrets

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:  # pragma: no cover
            return True
        clean = redact(msg, self.secrets)
        if clean != msg:
            record.msg, record.args = clean, ()
        return True


def _setup_logging(settings: Settings, verbose: bool) -> None:
    level = logging.DEBUG if verbose else getattr(logging, settings.log_level, logging.INFO)
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s", "%H:%M:%S"))
    handler.addFilter(_RedactFilter(settings.secrets()))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)
    # httpx registra URLs completas (incluido ?apikey=...): se silencia salvo en modo depuración.
    logging.getLogger("httpx").setLevel(logging.DEBUG if verbose else logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)


def _context(verbose: bool = False, no_cache: bool = False) -> AppContext:
    settings = Settings.from_env()
    _setup_logging(settings, verbose)
    return build_context(settings, transports=TRANSPORTS, use_cache=not no_cache)


def _fail(msg: str, code: int = 1) -> None:
    err_console.print(f"[bold red]Error:[/bold red] {msg}", highlight=False)
    raise typer.Exit(code)


# ---------------------------------------------------------------------- construcción de config


def _set(d: dict[str, Any], path: str, value: Any) -> None:
    keys = path.split(".")
    cur = d
    for k in keys[:-1]:
        nxt = cur.get(k)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[k] = nxt
        cur = nxt
    cur[keys[-1]] = value


def build_config(config: Path | None, flags: dict[str, Any]) -> CatalogConfig:
    data: dict[str, Any] = {}
    if config is not None:
        try:
            data = yaml.safe_load(config.read_text(encoding="utf-8")) or {}
        except FileNotFoundError:
            raise ConfigError(f"No existe el archivo de configuración: {config}") from None
        except yaml.YAMLError as err:
            raise ConfigError(f"YAML inválido en {config}: {err}") from err
    for path, value in flags.items():
        if value is None or value == [] or value == ():
            continue
        _set(data, path, list(value) if isinstance(value, tuple) else value)
    if not (data.get("catalog") or {}).get("name"):
        raise ConfigError("Falta el nombre del catálogo: usa --name o catalog.name en el YAML")
    return parse_config(data)


def _resolve_dry_run(cfg: CatalogConfig, settings: Settings, apply: bool, dry_run: bool) -> bool:
    if apply and dry_run:
        raise ConfigError("--apply y --dry-run son incompatibles")
    if apply:
        return False
    if dry_run:
        return True
    if "dry_run" in cfg.mdblist.model_fields_set:
        return cfg.mdblist.dry_run
    return settings.default_dry_run


def _run_catalog(cfg: CatalogConfig, *, apply: bool, dry_run: bool, confirm_replace: bool, offline: bool, verbose: bool,
                 no_cache: bool, report_dir: Path | None, show: int) -> int:
    ctx = _context(verbose, no_cache)
    try:
        dry = _resolve_dry_run(cfg, ctx.settings, apply, dry_run)
        if not dry and not ctx.settings.mdblist_api_key:
            _fail("Falta MDBLIST_API_KEY para aplicar cambios (define la variable o usa --dry-run).", 2)
        if not ctx.settings.has_tmdb and cfg.mapping.verify_tmdb:
            console.print("[yellow]Aviso:[/yellow] sin TMDB_API_KEY no se validan los IDs en TMDB; "
                          "los mappings se aceptan como HIGH_CONFIDENCE solo si su confianza supera el mínimo.")
        pipeline = CatalogPipeline(ctx, cfg, dry_run=dry, offline=offline, confirm_replace=confirm_replace)
        try:
            rep = pipeline.run()
        except (SyncError, MDBListError) as err:
            _fail(str(err), 3)
            return 3
        print_summary(console, rep, cfg, show_titles=show)
        base = report_dir or (Path(cfg.reports.directory) if cfg.reports.directory else ctx.settings.reports_dir)
        out = write_reports(rep, cfg, base)
        console.print(f"Reportes: {out}", markup=False)
        if rep.sync and rep.sync.interrupted:
            return 3
        return 0
    finally:
        ctx.close()


ConfigOpt = Annotated[Optional[Path], typer.Option("--config", "-c", help="Archivo YAML del catálogo")]


def _catalog_command(mode_default: str | None):
    def command(
        config: ConfigOpt = None,
        name: Annotated[Optional[str], typer.Option("--name", help="Nombre de la lista en MDBList")] = None,
        description: Annotated[Optional[str], typer.Option("--description")] = None,
        year_from: Annotated[Optional[int], typer.Option("--from", help="Año inicial (inclusive)")] = None,
        year_to: Annotated[Optional[int], typer.Option("--to", help="Año final (inclusive)")] = None,
        year: Annotated[Optional[list[int]], typer.Option("--year", help="Año concreto (repetible)")] = None,
        decade: Annotated[Optional[list[str]], typer.Option("--decade", help="Década: 1990 o 1990s (repetible)")] = None,
        date_from: Annotated[Optional[str], typer.Option("--date-from", help="Fecha mínima AAAA-MM-DD")] = None,
        date_to: Annotated[Optional[str], typer.Option("--date-to", help="Fecha máxima AAAA-MM-DD")] = None,
        season: Annotated[Optional[list[str]], typer.Option("--season", help="WINTER/SPRING/SUMMER/FALL (repetible)")] = None,
        first_only: Annotated[Optional[bool], typer.Option("--first-only/--all-entries", help="Una sola entrada por serie")] = None,
        min_score: Annotated[Optional[float], typer.Option("--min-score")] = None,
        max_score: Annotated[Optional[float], typer.Option("--max-score")] = None,
        score_provider: Annotated[Optional[str], typer.Option("--score-provider", help="anilist | myanimelist")] = None,
        score_field: Annotated[Optional[str], typer.Option("--score-field", help="averageScore | meanScore | score")] = None,
        fmt: Annotated[Optional[list[str]], typer.Option("--format", help="TV, TV_SHORT, MOVIE, OVA, ONA, SPECIAL, MUSIC")] = None,
        genre: Annotated[Optional[list[str]], typer.Option("--genre")] = None,
        exclude_genre: Annotated[Optional[list[str]], typer.Option("--exclude-genre")] = None,
        genre_mode: Annotated[Optional[str], typer.Option("--genre-mode", help="AND | OR")] = None,
        tag: Annotated[Optional[list[str]], typer.Option("--tag")] = None,
        exclude_tag: Annotated[Optional[list[str]], typer.Option("--exclude-tag")] = None,
        min_tag_rank: Annotated[Optional[int], typer.Option("--min-tag-rank")] = None,
        tag_mode: Annotated[Optional[str], typer.Option("--tag-mode", help="AND | OR")] = None,
        studio: Annotated[Optional[list[str]], typer.Option("--studio")] = None,
        exclude_studio: Annotated[Optional[list[str]], typer.Option("--exclude-studio")] = None,
        main_studio_only: Annotated[Optional[bool], typer.Option("--main-studio-only/--any-studio")] = None,
        temporal_mode: Annotated[Optional[str], typer.Option("--temporal-mode", help="original_release_year | any_season_release_year | entry_release_year")] = None,
        metadata_scope: Annotated[Optional[str], typer.Option("--metadata-scope", help="canonical | any_member | entry")] = None,
        source: Annotated[Optional[str], typer.Option("--source", help="anilist | myanimelist | hybrid")] = None,
        include_adult: Annotated[Optional[bool], typer.Option("--include-adult/--exclude-adult")] = None,
        include_future: Annotated[Optional[bool], typer.Option("--include-future/--exclude-future")] = None,
        limit: Annotated[Optional[int], typer.Option("--limit")] = None,
        sort: Annotated[Optional[str], typer.Option("--sort", help="start_date | score | popularity | favourites | title")] = None,
        order: Annotated[Optional[str], typer.Option("--order", help="asc | desc")] = None,
        mode: Annotated[Optional[str], typer.Option("--mode", help="create | append | sync | replace")] = mode_default,
        list_id: Annotated[Optional[int], typer.Option("--list-id", help="ID de lista MDBList existente")] = None,
        allow_removals: Annotated[Optional[bool], typer.Option("--allow-removals/--no-removals", help="sync: quitar elementos gestionados que ya no cumplen")] = None,
        private: Annotated[Optional[bool], typer.Option("--private/--public")] = None,
        min_confidence: Annotated[Optional[float], typer.Option("--min-confidence")] = None,
        apply: Annotated[bool, typer.Option("--apply", help="Escribir realmente en MDBList")] = False,
        dry_run: Annotated[bool, typer.Option("--dry-run", help="Simular sin modificar MDBList")] = False,
        confirm_replace: Annotated[bool, typer.Option("--confirm-replace", help="Confirmar eliminaciones del modo replace")] = False,
        offline: Annotated[bool, typer.Option("--offline", help="No descargar datasets de mappings")] = False,
        no_cache: Annotated[bool, typer.Option("--no-cache", help="Ignorar la caché local")] = False,
        report_dir: Annotated[Optional[Path], typer.Option("--report-dir")] = None,
        show: Annotated[int, typer.Option("--show", help="Títulos a mostrar en consola")] = 30,
        verbose: Annotated[bool, typer.Option("--verbose", "-v")] = False,
    ) -> None:
        score: dict[str, Any] = {}
        if min_score is not None or max_score is not None:
            score = {"min": min_score, "max": max_score}
            if score_provider:
                score["provider"] = score_provider
            if score_field:
                score["field"] = score_field
        flags = {
            "catalog.name": name, "catalog.description": description,
            "filters.start_year": year_from, "filters.end_year": year_to, "filters.years": year, "filters.decades": decade,
            "filters.date_from": date_from, "filters.date_to": date_to, "filters.seasons": season,
            "canonical.first_only": first_only, "filters.formats": [f.upper() for f in fmt] if fmt else None,
            "filters.temporal_mode": temporal_mode, "filters.metadata_scope": metadata_scope,
            "filters.include_adult": include_adult, "filters.include_future": include_future,
            "filters.limit": limit, "filters.sort": sort, "filters.order": order,
            "source.primary": source, "mdblist.mode": mode, "mdblist.list_id": list_id,
            "mdblist.allow_removals": allow_removals, "mdblist.private": private,
            "mapping.minimum_confidence": min_confidence,
        }
        if score:
            flags.update({f"filters.score.{k}": v for k, v in score.items() if v is not None})
        for key, inc, exc, extra in (
            ("genres", genre, exclude_genre, {"mode": genre_mode}),
            ("tags", tag, exclude_tag, {"mode": tag_mode, "min_rank": min_tag_rank}),
            ("studios", studio, exclude_studio, {"main_only": main_studio_only}),
        ):
            flags[f"filters.{key}.include"] = inc
            flags[f"filters.{key}.exclude"] = exc
            for k, v in extra.items():
                flags[f"filters.{key}.{k}"] = v
        try:
            cfg = build_config(config, flags)
        except ConfigError as err:
            _fail(str(err), 2)
            return
        try:
            code = _run_catalog(cfg, apply=apply, dry_run=dry_run, confirm_replace=confirm_replace, offline=offline,
                                verbose=verbose, no_cache=no_cache, report_dir=report_dir, show=show)
        except ConfigError as err:
            _fail(str(err), 2)
            return
        except (HttpError, RuntimeError) as err:
            _fail(str(err), 1)
            return
        raise typer.Exit(code)

    return command


app.command("create", help="Crea (o actualiza en modo append) un catálogo en MDBList.")(_catalog_command(None))
app.command("sync", help="Sincroniza un catálogo existente (modo sync por defecto: añade y, con --allow-removals, quita lo gestionado).")(
    _catalog_command("sync")
)


@app.command("sync-all", help="Ejecuta todos los perfiles YAML habilitados de un directorio (para GitHub Actions).")
def sync_all(
    directory: Annotated[Path, typer.Option("--dir", help="Directorio con perfiles YAML")] = Path("filters"),
    profile: Annotated[Optional[list[str]], typer.Option("--profile", help="Solo estos perfiles (nombre de archivo sin .yaml)")] = None,
    mode: Annotated[Optional[str], typer.Option("--mode")] = None,
    apply: Annotated[bool, typer.Option("--apply")] = False,
    dry_run: Annotated[bool, typer.Option("--dry-run")] = False,
    offline: Annotated[bool, typer.Option("--offline")] = False,
    report_dir: Annotated[Optional[Path], typer.Option("--report-dir")] = None,
    verbose: Annotated[bool, typer.Option("--verbose", "-v")] = False,
) -> None:
    files = sorted(directory.glob("*.yaml")) + sorted(directory.glob("*.yml"))
    if profile:
        files = [f for f in files if f.stem in profile]
        missing = set(profile) - {f.stem for f in files}
        if missing:
            _fail(f"Perfiles no encontrados en {directory}: {sorted(missing)}", 2)
    worst = 0
    for f in files:
        try:
            cfg = build_config(f, {"mdblist.mode": mode})
        except ConfigError as err:
            err_console.print(f"[red]{f.name}[/red]: {err}")
            worst = max(worst, 2)
            continue
        if not cfg.catalog.enabled and not profile:
            console.print(f"Omitido (deshabilitado): {f.name}")
            continue
        console.rule(f"{cfg.catalog.name} ({f.name})")
        try:
            code = _run_catalog(cfg, apply=apply, dry_run=dry_run, confirm_replace=False, offline=offline, verbose=verbose,
                                no_cache=False, report_dir=report_dir, show=10)
        except typer.Exit as ex:
            code = ex.exit_code or 0
        except (HttpError, RuntimeError, ConfigError) as err:
            err_console.print(f"[red]{f.name}[/red]: {err}")
            code = 1
        worst = max(worst, code)
    raise typer.Exit(worst)


@app.command("validate", help="Valida uno o varios archivos YAML de catálogo.")
def validate(files: list[Path]) -> None:
    bad = 0
    for f in files:
        try:
            cfg = load_config(f)
            console.print(f"[green]OK[/green] {f}: {cfg.catalog.name} · modo {cfg.filters.temporal_mode.value} · "
                          f"formatos {cfg.filters.formats} · {cfg.mdblist.mode.value}")
        except ConfigError as err:
            bad += 1
            err_console.print(f"[red]ERROR[/red] {f}:\n{err}")
    raise typer.Exit(1 if bad else 0)


# ---------------------------------------------------------------------- mapping individual


@app.command("mapping", help="Muestra cómo se resuelve un anime: serie canónica, IDs externos, fuente y validación.")
def mapping_cmd(
    anilist_id: Annotated[Optional[int], typer.Option("--anilist-id")] = None,
    mal_id: Annotated[Optional[int], typer.Option("--mal-id")] = None,
    offline: Annotated[bool, typer.Option("--offline")] = False,
    as_json: Annotated[bool, typer.Option("--json")] = False,
    verbose: Annotated[bool, typer.Option("--verbose", "-v")] = False,
) -> None:
    if not anilist_id and not mal_id:
        _fail("Indica --anilist-id o --mal-id", 2)
    ctx = _context(verbose)
    try:
        cfg = parse_config({"catalog": {"name": "mapping"}})
        if not offline:
            for r in ctx.updater.ensure([s for s in cfg.mapping.source_order() if s in ("anibridge", "kometa", "fribb")]):
                if r.status == "failed":
                    err_console.print(f"[yellow]{r.source}: {r.message}[/yellow]")
        entry: AnimeEntry | None
        if anilist_id:
            entry = ctx.anilist.get(anilist_id)
        else:
            got = ctx.anilist.fetch_ids(mal_ids=[mal_id]) if mal_id else {}
            entry = next(iter(got.values()), None) or (ctx.jikan.anime(mal_id) if mal_id else None)
        if entry is None:
            _fail("Anime no encontrado en el proveedor", 1)
            return
        canon = CanonicalAnimeResolver(ctx.index, cfg.canonical, lambda u: _fetch(ctx, u), db=ctx.db,
                                       source_order=cfg.mapping.source_order())
        groups = canon.resolve({entry.uid: entry})
        group = next(g for g in groups if entry.uid in g.members)
        resolver = MappingResolver(ctx.db, ctx.index, cfg.mapping, ctx.tmdb)
        root = group.root
        res = resolver.resolve_entry(root, "movie" if root.format == "MOVIE" else "tv", check_year=True)
        own = resolver.resolve_entry(entry, "movie" if entry.format == "MOVIE" else "tv", check_year=entry.uid == root.uid)
        rt = resolver.to_resolved(root, res, members=[m.uid for m in group.member_list()], grouping=group.criteria)
        if as_json:
            console.print_json(json.dumps({"entry": entry.uid, "entry_mapping": {"type": own.media_type, "tmdb_id": own.tmdb_id,
                                           "season": own.season, "status": own.status.value},
                                           "canonical": json.loads(rt.model_dump_json())}, ensure_ascii=False))
            return
        t = Table(title=f"Mapping de {entry.uid}", show_header=False)
        t.add_column("Campo", style="bold")
        t.add_column("Valor")
        t.add_row("Anime encontrado", f"{entry.title} ({entry.format}, {entry.start_date}) [{entry.uid}]")
        t.add_row("Mapping de la entrada", f"{own.media_type}:{own.tmdb_id} temporada {own.season}" if own.tmdb_id else own.status.value)
        t.add_row("Serie canónica", f"{root.title} ({root.format}, {root.start_date}) [{root.uid}]")
        t.add_row("Miembros del grupo", ", ".join(f"{m.uid} {m.title} ({m.start_date.year})" for m in group.member_list()))
        t.add_row("Criterio de agrupación", "\n".join(group.criteria) or "-")
        t.add_row("AniList ID", str(root.anilist_id or "-"))
        t.add_row("MAL ID", str(root.mal_id or "-"))
        t.add_row("TMDB", f"{rt.media_type}:{rt.tmdb_id}" if rt.tmdb_id else "-")
        t.add_row("TVDB ID", str(rt.tvdb_id or "-"))
        t.add_row("IMDb ID", str(rt.imdb_id or "-"))
        t.add_row("AniDB", ", ".join(map(str, res.external.anidb)) or "-")
        t.add_row("Fuente del mapping", rt.mapping_source or "-")
        t.add_row("Estado", rt.mapping_status.value)
        t.add_row("Confianza", f"{rt.confidence:.2f}")
        t.add_row("Validación TMDB", json.dumps(rt.validation.checks, ensure_ascii=False) if rt.validation.performed
                  else ("no realizada (sin TMDB_API_KEY)" if not ctx.tmdb else "no realizada"))
        t.add_row("Evidencias", "\n".join(rt.evidence) or "-")
        t.add_row("Conflictos", "\n".join(rt.conflicts) or "-")
        t.add_row("Datasets", ", ".join(f"{k}={v}" for k, v in rt.dataset_versions.items()) or "-")
        console.print(t)
        if res.candidates:
            ct = Table(title="Candidatos por fuente (agrupados)")
            for col in ("Fuente", "Tipo", "TMDB", "Temporadas", "Vía"):
                ct.add_column(col)
            agg: dict[tuple[str, str, Any, str], list[Any]] = {}
            for c in res.candidates:
                via = str(c.get("via") or c.get("detail") or "").split(":")[0]
                agg.setdefault((str(c.get("source")), str(c.get("type")), c.get("tmdb_id"), via), []).append(c.get("season"))
            for (src, typ, tid, via), seasons in agg.items():
                ss = sorted({s for s in seasons if s is not None})
                ct.add_row(src, typ, str(tid), _compact(ss) if ss else "-", via)
            console.print(ct)
    finally:
        ctx.close()


def _compact(nums: list[int]) -> str:
    """[1,2,3,5] -> '1-3, 5'"""
    out: list[str] = []
    start = prev = nums[0]
    for n in nums[1:] + [None]:  # type: ignore[list-item]
        if n is not None and n == prev + 1:
            prev = n
            continue
        out.append(f"s{start}" if start == prev else f"s{start}-s{prev}")
        if n is not None:
            start = prev = n
    return ", ".join(out)


def _fetch(ctx: AppContext, uids: list[str]) -> dict[str, AnimeEntry]:
    ids = [int(u.split(":")[1]) for u in uids if u.startswith("anilist:")]
    mals = [int(u.split(":")[1]) for u in uids if u.startswith("mal:")]
    out = ctx.anilist.fetch_ids(ids) if ids else {}
    if mals:
        out.update(ctx.jikan.fetch_ids(mals))
    return out


# ---------------------------------------------------------------------- datasets


@mappings_app.command("update", help="Comprueba y descarga versiones nuevas de los datasets (ETag), valida e indexa.")
def mappings_update(
    source: Annotated[Optional[list[str]], typer.Option("--source", help="anibridge | kometa | fribb | anime_lists")] = None,
    force: Annotated[bool, typer.Option("--force", help="Descargar aunque no haya cambios")] = False,
    verbose: Annotated[bool, typer.Option("--verbose", "-v")] = False,
) -> None:
    ctx = _context(verbose)
    try:
        results = ctx.updater.update(source or None, force=force)
        t = Table(title="Actualización de mappings")
        for col in ("Fuente", "Estado", "Versión", "Filas", "Mensaje"):
            t.add_column(col)
        for r in results:
            color = {"updated": "green", "unchanged": "cyan", "failed": "red"}.get(r.status, "white")
            t.add_row(r.source, f"[{color}]{r.status}[/{color}]", r.version or "", str(r.rows or ""), r.message)
        console.print(t)
        raise typer.Exit(1 if any(r.status == "failed" for r in results) else 0)
    finally:
        ctx.close()


@mappings_app.command("status", help="Versiones, filas indexadas y licencias de cada dataset.")
def mappings_status() -> None:
    ctx = _context()
    try:
        t = Table(title="Datasets de mappings")
        for col in ("Fuente", "Estado", "Versión", "Filas", "Anterior", "Por defecto", "Licencia"):
            t.add_column(col)
        for s in ctx.updater.status():
            t.add_row(s["source"], s["status"], str(s["version"] or ""), str(s["rows"] or ""), str(s["previous_version"] or ""),
                      "sí" if s["enabled_by_default"] else "no", s["license"])
        console.print(t)
    finally:
        ctx.close()


@mappings_app.command("rollback", help="Restaura la versión anterior válida de un dataset.")
def mappings_rollback(source: Annotated[str, typer.Option("--source")]) -> None:
    ctx = _context()
    try:
        r = ctx.updater.rollback(source)
        console.print(f"{r.source}: {r.status} {r.version or ''} {r.message}")
        raise typer.Exit(0 if r.status == "rolled_back" else 1)
    finally:
        ctx.close()


# ---------------------------------------------------------------------- revisión y overrides


@review_app.callback()
def review_main(
    ctx_typer: typer.Context,
    status: Annotated[Optional[str], typer.Option("--status", help="needs_review | conflict | unmapped")] = None,
) -> None:
    if ctx_typer.invoked_subcommand is not None:
        return
    ctx = _context()
    try:
        items = ctx.db.list_review(status)
        if not items:
            console.print("No hay correspondencias pendientes de revisión.")
            return
        t = Table(title=f"Pendientes de revisión ({len(items)})")
        for col in ("UID", "Título", "Estado", "Motivo", "Candidatos", "Catálogo"):
            t.add_column(col)
        for it in items:
            cands = it["candidates"] or []
            cs = ", ".join(sorted({f"{c.get('type')}:{c.get('tmdb_id')}({c.get('source')})" for c in cands}))[:120]
            t.add_row(it["uid"], it["title"] or "", it["status"], (it["reason"] or "")[:160], cs, it["catalog"] or "")
        console.print(t)
        console.print("Aplica una corrección con: anime-catalog review set anilist:ID --tmdb-tv N | --tmdb-movie N | --exclude")
    finally:
        ctx.close()


@review_app.command("set", help="Crea/actualiza un override manual (persistente; no se pierde al actualizar mappings).")
def review_set(
    uid: Annotated[str, typer.Argument(help="anilist:ID o mal:ID")],
    tmdb_tv: Annotated[Optional[int], typer.Option("--tmdb-tv")] = None,
    tmdb_movie: Annotated[Optional[int], typer.Option("--tmdb-movie")] = None,
    exclude: Annotated[bool, typer.Option("--exclude", help="No añadir nunca esta entrada")] = False,
    canonical: Annotated[Optional[str], typer.Option("--canonical", help="uid de la serie canónica a la que pertenece")] = None,
    note: Annotated[Optional[str], typer.Option("--note")] = None,
    export: Annotated[bool, typer.Option("--export/--no-export", help="Actualizar también overrides.yaml")] = True,
) -> None:
    if not uid.startswith(("anilist:", "mal:")):
        _fail("El uid debe tener la forma anilist:ID o mal:ID", 2)
    chosen = [x for x in (tmdb_tv, tmdb_movie, exclude or None, canonical) if x]
    if len(chosen) != 1:
        _fail("Indica exactamente una acción: --tmdb-tv, --tmdb-movie, --exclude o --canonical", 2)
    ctx = _context()
    try:
        if tmdb_tv:
            ctx.db.set_override(uid, "map", "tv", tmdb_tv, note=note)
        elif tmdb_movie:
            ctx.db.set_override(uid, "map", "movie", tmdb_movie, note=note)
        elif exclude:
            ctx.db.set_override(uid, "exclude", note=note)
        else:
            ctx.db.set_override(uid, "canonical", canonical_uid=canonical, note=note)
        console.print(f"Override guardado para {uid}")
        if export:
            n = export_overrides(ctx.db, ctx.settings.overrides_path)
            console.print(f"{n} override(s) exportados a {ctx.settings.overrides_path}")
    finally:
        ctx.close()


@review_app.command("remove", help="Elimina un override manual.")
def review_remove(uid: str, export: Annotated[bool, typer.Option("--export/--no-export")] = True) -> None:
    ctx = _context()
    try:
        ok = ctx.db.delete_override(uid)
        console.print(f"Override de {uid} eliminado" if ok else f"No había override para {uid}")
        if export and ok:
            export_overrides(ctx.db, ctx.settings.overrides_path)
    finally:
        ctx.close()


@review_app.command("list-overrides", help="Muestra los overrides manuales.")
def review_list_overrides() -> None:
    ctx = _context()
    try:
        t = Table(title="Overrides")
        for col in ("UID", "Acción", "Tipo", "TMDB", "Canónico", "Nota"):
            t.add_column(col)
        for o in ctx.db.list_overrides():
            t.add_row(o["uid"], o["action"], str(o["media_type"] or ""), str(o["tmdb_id"] or ""), str(o["canonical_uid"] or ""), o["note"] or "")
        console.print(t)
    finally:
        ctx.close()


@review_app.command("export", help="Exporta los overrides a YAML.")
def review_export(path: Annotated[Optional[Path], typer.Argument()] = None) -> None:
    ctx = _context()
    try:
        target = path or ctx.settings.overrides_path
        console.print(f"{export_overrides(ctx.db, target)} override(s) exportados a {target}")
    finally:
        ctx.close()


@review_app.command("import", help="Importa overrides desde YAML.")
def review_import(path: Path) -> None:
    ctx = _context()
    try:
        console.print(f"{import_overrides(ctx.db, path)} override(s) importados desde {path}")
    finally:
        ctx.close()


@app.command("runs", help="Últimas ejecuciones registradas.")
def runs(limit: int = 15) -> None:
    ctx = _context()
    try:
        t = Table(title="Ejecuciones")
        for col in ("Run", "Catálogo", "Modo", "Dry-run", "Lista", "Estado", "Resumen"):
            t.add_column(col)
        for r in ctx.db.conn.execute("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?", (limit,)):
            s = json.loads(r["summary"] or "{}").get("stats", {})
            t.add_row(r["run_id"], r["catalog"] or "", r["mode"] or "", "sí" if r["dry_run"] else "no", str(r["list_id"] or ""),
                      r["status"] or "", f"válidos {s.get('valid_titles', '?')} · nuevos {s.get('new_titles', '?')} · añadidos {s.get('added', 0)}")
        console.print(t)
    finally:
        ctx.close()


@state_app.command("export", help="Exporta el estado a JSON (p. ej. para guardarlo en la rama de estado de GitHub).")
def state_export(path: Path) -> None:
    ctx = _context()
    try:
        console.print(f"Estado exportado a {path}: {export_state(ctx.db, path)}")
    finally:
        ctx.close()


@state_app.command("import", help="Importa el estado desde JSON (si el archivo existe).")
def state_import(path: Path) -> None:
    ctx = _context()
    try:
        if not path.is_file():
            console.print(f"No existe {path}: se empieza sin estado previo")
            return
        console.print(f"Estado importado desde {path}: {import_state(ctx.db, path)}")
    finally:
        ctx.close()


@app.command("version")
def version() -> None:
    console.print(f"anime-catalog-generator {__version__}")


def main() -> None:
    app()


if __name__ == "__main__":
    main()
