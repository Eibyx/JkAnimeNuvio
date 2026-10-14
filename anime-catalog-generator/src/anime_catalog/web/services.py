"""Lógica de la interfaz web: reutiliza el motor existente (pipeline, filtros, CanonicalAnimeResolver,
MappingResolver, SyncEngine). No hay una segunda implementación de filtros ni de mappings aquí."""

from __future__ import annotations

import json
import re
from collections import OrderedDict
from pathlib import Path
from typing import Any

import yaml

from ..catalog.canonical import CanonicalAnimeResolver
from ..catalog.pipeline import CatalogPipeline
from ..catalog.progress import Progress
from ..config import (
    CatalogConfig,
    ConfigError,
    MetadataScope,
    Settings,
    SyncMode,
    TemporalMode,
    parse_config,
)
from ..context import AppContext, Transports, build_context
from ..mapping.index import DATASET_CLASSES
from ..mapping.resolver import MappingResolver
from ..models import ADDABLE_STATUSES, FORMATS, SEASONS, STATUSES, AnimeEntry
from ..reporting.reports import write_reports
from ..storage.overrides import export_overrides

PROFILE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
FALLBACK_GENRES = ["Action", "Adventure", "Comedy", "Drama", "Ecchi", "Fantasy", "Horror", "Mahou Shoujo", "Mecha", "Music",
                   "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller"]
SOURCES_ADAPTATION = ["ORIGINAL", "MANGA", "LIGHT_NOVEL", "VISUAL_NOVEL", "VIDEO_GAME", "OTHER", "NOVEL", "DOUJINSHI", "ANIME",
                      "WEB_NOVEL", "LIVE_ACTION", "GAME", "COMIC", "MULTIMEDIA_PROJECT", "PICTURE_BOOK"]
COUNTRIES = ["JP", "CN", "KR", "TW"]
SEARCH_KINDS = ("title", "anilist", "mal", "anidb", "tmdb", "tvdb", "imdb")
PROVIDERS_BY_KIND = {
    "mal": ["mal"],
    "anidb": ["anidb"],
    "tmdb": ["tmdb_show", "tmdb_movie"],
    "tvdb": ["tvdb_show", "tvdb_movie"],
    "imdb": ["imdb", "imdb_movie", "imdb_show"],
}


class ServiceError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def paginate(items: list[Any], page: int, size: int) -> dict[str, Any]:
    size = max(1, min(size, 200))
    total = len(items)
    pages = max(1, (total + size - 1) // size)
    page = max(1, min(page, pages))
    return {"items": items[(page - 1) * size : page * size], "page": page, "size": size, "total": total, "pages": pages}


class Services:
    def __init__(self, settings: Settings, transports: Transports | None = None):
        self.settings = settings
        self.transports = transports
        self._reports: OrderedDict[str, dict[str, Any]] = OrderedDict()

    # ------------------------------------------------------------------ contexto
    def context(self) -> AppContext:
        return build_context(self.settings, transports=self.transports)

    def reload_settings(self) -> None:
        self.settings = Settings.from_env(env_file=None if self.settings.home else self.settings.env_file)

    # ------------------------------------------------------------------ opciones del formulario
    def options(self) -> dict[str, Any]:
        genres: list[str] = FALLBACK_GENRES
        tags: list[dict[str, Any]] = []
        meta_note = None
        ctx = self.context()
        try:
            meta = ctx.anilist.catalog_metadata()
            genres = [g for g in meta["genres"] if g != "Hentai"] or FALLBACK_GENRES
            tags = meta["tags"]
        except Exception as err:  # sin red: lista de géneros básica, sin tags
            meta_note = f"No se pudieron cargar géneros/tags de AniList: {err}"
        finally:
            ctx.close()
        return {
            "formats": list(FORMATS), "seasons": list(SEASONS), "statuses": list(STATUSES),
            "sources": ["anilist", "myanimelist", "hybrid"],
            "temporal_modes": [m.value for m in TemporalMode], "metadata_scopes": [m.value for m in MetadataScope],
            "sync_modes": [m.value for m in SyncMode], "adaptation_sources": SOURCES_ADAPTATION, "countries": COUNTRIES,
            "sort_fields": ["start_date", "score", "popularity", "favourites", "title"],
            "genres": genres, "tags": tags, "note": meta_note,
            "defaults": json.loads(parse_config({"catalog": {"name": "Nuevo catálogo"}}).model_dump_json(by_alias=True)),
        }

    def studios(self, q: str) -> list[dict[str, Any]]:
        if len(q.strip()) < 2:
            return []
        ctx = self.context()
        try:
            return [{"id": s["id"], "name": s["name"], "animation": s.get("isAnimationStudio", True)} for s in ctx.anilist.find_studios(q.strip())]
        finally:
            ctx.close()

    # ------------------------------------------------------------------ configuración y perfiles
    @staticmethod
    def validate(config: dict[str, Any]) -> CatalogConfig:
        try:
            return parse_config(config)
        except ConfigError as err:
            raise ServiceError(str(err), 422) from err

    @staticmethod
    def to_yaml(cfg: CatalogConfig) -> str:
        data = cfg.model_dump(mode="json", by_alias=True, exclude_defaults=True)
        data.setdefault("catalog", {})["name"] = cfg.catalog.name
        return yaml.safe_dump(data, allow_unicode=True, sort_keys=False)

    @staticmethod
    def from_yaml(text: str) -> CatalogConfig:
        try:
            data = yaml.safe_load(text) or {}
        except yaml.YAMLError as err:
            raise ServiceError(f"YAML inválido: {err}", 422) from err
        if not isinstance(data, dict):
            raise ServiceError("El YAML debe ser un objeto", 422)
        return Services.validate(data)

    def _profile_path(self, name: str) -> Path:
        if not PROFILE_NAME.match(name):
            raise ServiceError("Nombre de perfil inválido (letras, números, punto, guion y guion bajo)")
        return self.settings.profiles_dir / f"{name.removesuffix('.yaml')}.yaml"

    def list_profiles(self) -> list[dict[str, Any]]:
        d = self.settings.profiles_dir
        out = []
        for f in sorted(list(d.glob("*.yaml")) + list(d.glob("*.yml"))) if d.is_dir() else []:
            item: dict[str, Any] = {"name": f.stem, "file": f.name}
            try:
                cfg = self.from_yaml(f.read_text(encoding="utf-8"))
                item.update(catalog=cfg.catalog.name, description=cfg.catalog.description, enabled=cfg.catalog.enabled,
                            formats=cfg.filters.formats, mode=cfg.mdblist.mode.value, valid=True)
            except ServiceError as err:
                item.update(valid=False, error=str(err))
            out.append(item)
        return out

    def load_profile(self, name: str) -> dict[str, Any]:
        path = self._profile_path(name)
        if not path.is_file():
            raise ServiceError("Perfil no encontrado", 404)
        text = path.read_text(encoding="utf-8")
        cfg = self.from_yaml(text)
        return {"name": path.stem, "yaml": text, "config": json.loads(cfg.model_dump_json(by_alias=True))}

    def save_profile(self, name: str, config: dict[str, Any]) -> dict[str, Any]:
        cfg = self.validate(config)
        path = self._profile_path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        text = self.to_yaml(cfg)
        path.write_text(text, encoding="utf-8")
        return {"name": path.stem, "yaml": text}

    def delete_profile(self, name: str) -> bool:
        path = self._profile_path(name)
        if path.is_file():
            path.unlink()
            return True
        return False

    # ------------------------------------------------------------------ trabajos
    @staticmethod
    def list_key(cfg: CatalogConfig) -> str:
        return f"id:{cfg.mdblist.list_id}" if cfg.mdblist.list_id else f"name:{cfg.catalog.name.strip().casefold()}"

    def run_catalog(self, cfg: CatalogConfig, progress: Progress, *, apply: bool, confirm_replace: bool) -> dict[str, Any]:
        ctx = self.context()
        try:
            pipeline = CatalogPipeline(ctx, cfg, dry_run=not apply, confirm_replace=confirm_replace, progress=progress)
            rep = pipeline.run()
            base = Path(cfg.reports.directory) if cfg.reports.directory else self.settings.reports_dir
            out = write_reports(rep, cfg, base)
            plan, sync = rep.plan, rep.sync
            return {
                "run_id": rep.run_id, "catalog": rep.catalog, "dry_run": rep.dry_run, "report_dir": str(out),
                "stats": rep.stats, "mapping_sources": rep.mapping_sources, "dataset_versions": rep.dataset_versions,
                "errors": rep.errors[:100], "notes": rep.notes,
                "list": {
                    "name": plan.list_name if plan else cfg.catalog.name,
                    "id": (sync.list_id if sync and sync.list_id else None) or (plan.list_id if plan else None),
                    "will_create": bool(plan and plan.will_create and not sync),
                    "created": bool(sync and sync.created), "to_add": len(plan.to_add) if plan else 0,
                    "already_present": len(plan.already_present) if plan else 0,
                    "to_remove": len(plan.to_remove) if plan else 0,
                    "remove_preview": [{"type": m, "tmdb_id": t, "title": (plan.existing.get((m, t)) or {}).get("title")}
                                       for m, t in (plan.to_remove if plan else [])[:200]],
                    "notes": plan.notes if plan else [],
                },
                "sync": None if not sync else {
                    "added": len(sync.added), "removed": len(sync.removed), "not_found": [list(x) for x in sync.not_found],
                    "failed": [list(x) for x in sync.failed], "errors": sync.errors, "interrupted": sync.interrupted,
                },
                "cancelled": bool(sync and sync.cancelled),
            }
        finally:
            ctx.close()

    def run_datasets(self, progress: Progress, sources: list[str] | None, force: bool) -> dict[str, Any]:
        ctx = self.context()
        try:
            names = sources or [n for n, c in DATASET_CLASSES.items() if c.enabled_by_default]
            progress.phase("Actualizando datasets de mappings", len(names))
            results = []
            for name in names:
                progress.check()
                progress.log(f"{name}: comprobando versión")
                r = ctx.updater.update([name], force=force)[0]
                results.append({"source": r.source, "status": r.status, "version": r.version, "rows": r.rows, "message": r.message})
                if r.status == "failed":
                    progress.error(f"{name}: {r.message}")
                progress.advance(1, name)
            return {"datasets": results}
        finally:
            ctx.close()

    def report(self, report_dir: str) -> dict[str, Any]:
        if report_dir in self._reports:
            self._reports.move_to_end(report_dir)
            return self._reports[report_dir]
        path = Path(report_dir) / "summary.json"
        if not path.is_file():
            raise ServiceError("El reporte ya no está disponible", 404)
        data = json.loads(path.read_text(encoding="utf-8"))
        self._reports[report_dir] = data
        while len(self._reports) > 3:  # memoria acotada
            self._reports.popitem(last=False)
        return data

    def report_rows(self, report_dir: str, section: str, page: int, size: int, q: str = "", status: str = "") -> dict[str, Any]:
        data = self.report(report_dir)
        if section not in ("titles", "excluded", "review", "duplicates"):
            raise ServiceError("Sección desconocida")
        rows = data.get(section) or []
        if status:
            rows = [r for r in rows if r.get("mapping_status") == status or r.get("stage") == status]
        if q:
            qq = q.casefold()
            rows = [r for r in rows if qq in json.dumps(r, ensure_ascii=False).casefold()]
        return paginate(rows, page, size)

    # ------------------------------------------------------------------ dashboard
    def dashboard(self, jobs: list[dict[str, Any]]) -> dict[str, Any]:
        ctx = self.context()
        try:
            db = ctx.db.conn
            m = db.execute(
                "SELECT COUNT(*) total, SUM(media_type='tv' AND status IN ('confirmed','high_confidence')) tv, "
                "SUM(media_type='movie' AND status IN ('confirmed','high_confidence')) movies, "
                "SUM(status IN ('confirmed','high_confidence')) resolved FROM mappings"
            ).fetchone()
            review = {r[0]: r[1] for r in db.execute("SELECT status, COUNT(*) FROM review_queue GROUP BY status")}
            runs = [dict(r) for r in db.execute("SELECT run_id, catalog, mode, dry_run, list_id, status, started_at, finished_at, summary "
                                                "FROM runs ORDER BY started_at DESC LIMIT 200")]
            latest: dict[str, dict[str, Any]] = {}
            for r in runs:
                r["summary"] = json.loads(r["summary"] or "{}")
                latest.setdefault(r["catalog"], r)
            dups = sum(int((r["summary"].get("stats") or {}).get("duplicates_removed", 0)) for r in latest.values())
            last_sync = next((r for r in runs if not r["dry_run"] and r["status"] in ("ok", "interrupted")), None)
            return {
                "catalogs": len(latest),
                "profiles": len(self.list_profiles()),
                "anime_identified": m["total"] or 0,
                "series": m["tv"] or 0,
                "movies": m["movies"] or 0,
                "mappings_resolved": m["resolved"] or 0,
                "mappings_pending": sum(review.values()),
                "pending_by_status": review,
                "duplicates_removed": dups,
                "last_sync": _run_brief(last_sync) if last_sync else None,
                "recent_runs": [_run_brief(r) for r in runs[:8]],
                "datasets": ctx.updater.status(),
                "settings": self.settings.public_summary(),
                "active_jobs": [j for j in jobs if j["status"] in ("queued", "running")],
            }
        finally:
            ctx.close()

    def runs(self, page: int, size: int) -> dict[str, Any]:
        ctx = self.context()
        try:
            rows = [dict(r) for r in ctx.db.conn.execute(
                "SELECT run_id, catalog, list_name, list_id, mode, dry_run, status, started_at, finished_at, summary "
                "FROM runs ORDER BY started_at DESC LIMIT 1000")]
            for r in rows:
                r.update(_run_brief({**r, "summary": json.loads(r["summary"] or "{}")}))
                r.pop("summary", None)
            return paginate(rows, page, size)
        finally:
            ctx.close()

    def run_items(self, run_id: str, status: str = "") -> list[dict[str, Any]]:
        ctx = self.context()
        try:
            q = "SELECT media_type, tmdb_id, action, status, error, list_id FROM sync_items WHERE run_id=?"
            args: list[Any] = [run_id]
            if status:
                q += " AND status=?"
                args.append(status)
            return [dict(r) for r in ctx.db.conn.execute(q + " ORDER BY status, tmdb_id LIMIT 2000", args)]
        finally:
            ctx.close()

    # ------------------------------------------------------------------ explorador de mappings
    def _anilist_ids_for(self, ctx: AppContext, kind: str, value: str) -> list[int]:
        ids: set[int] = set()
        for prov in PROVIDERS_BY_KIND[kind]:
            for h in ctx.index.forward(prov, value):
                if h.dst_provider == "anilist" and h.dst_id.isdigit():
                    ids.add(int(h.dst_id))
            for h in ctx.index.reverse(prov, value):
                if h.src_provider == "anilist" and h.src_id.isdigit():
                    ids.add(int(h.src_id))
        return sorted(ids)

    def search(self, kind: str, q: str, page: int = 1, size: int = 20, remote: bool = True) -> dict[str, Any]:
        q = (q or "").strip()
        if kind not in SEARCH_KINDS:
            raise ServiceError(f"Tipo de búsqueda inválido: {kind}")
        if not q:
            return paginate([], 1, size)
        ctx = self.context()
        try:
            entries: list[AnimeEntry] = []
            has_more = False
            note = None
            if kind == "title":
                like = f"%{q}%"
                rows = ctx.db.conn.execute(
                    "SELECT data FROM anime WHERE provider='anilist' AND (title LIKE ? COLLATE NOCASE OR data LIKE ? COLLATE NOCASE) "
                    "ORDER BY start_date LIMIT 200", (like, like)).fetchall()
                local = [AnimeEntry.model_validate_json(r[0]) for r in rows]
                result: dict[str, Any]
                if remote:
                    try:
                        found, has_more = ctx.anilist.search(q, page=page, per_page=size)
                        seen = {e.uid for e in found}
                        extra = [e for e in local if e.uid not in seen][:5] if page == 1 else []
                        result = {"items": found + extra, "page": page, "size": size, "total": None, "pages": None,
                                  "has_more": has_more}
                    except Exception as err:
                        note = f"Búsqueda en AniList no disponible ({err}); se muestran resultados locales"
                        result = paginate(local, page, size)
                else:
                    result = paginate(local, page, size)
            else:
                if kind == "imdb" and not q.startswith("tt"):
                    raise ServiceError("Un IMDb ID tiene la forma tt1234567")
                if kind != "imdb" and not q.isdigit():
                    raise ServiceError("El ID debe ser numérico")
                if kind == "anilist":
                    ids = [int(q)]
                else:
                    ids = self._anilist_ids_for(ctx, kind, q)
                    if kind == "mal" and not ids:
                        got = ctx.anilist.fetch_ids(mal_ids=[int(q)])
                        ids = [e.anilist_id for e in got.values() if e.anilist_id]
                pg = paginate(ids, page, size)
                fetched = ctx.anilist.fetch_ids(pg["items"]) if pg["items"] else {}
                entries = [fetched[f"anilist:{i}"] for i in pg["items"] if f"anilist:{i}" in fetched]
                result = {**pg, "items": entries}
                if not ids:
                    note = "Ningún dataset relaciona ese identificador con AniList"
            cfg = parse_config({"catalog": {"name": "explorer"}})
            resolver = MappingResolver(ctx.db, ctx.index, cfg.mapping, None)
            resolver.prefetch(result["items"])
            items = []
            for e in result["items"]:
                r = resolver.resolve_entry(e)
                items.append({**_entry_brief(e), "media_type": r.media_type, "tmdb_id": r.tmdb_id, "status": r.status.value,
                              "source": r.source, "confidence": round(r.confidence, 3), "conflicts": len(r.conflicts)})
            return {**result, "items": items, "note": note}
        finally:
            ctx.close()

    def detail(self, uid: str) -> dict[str, Any]:
        if not re.match(r"^(anilist|mal):\d+$", uid):
            raise ServiceError("uid inválido (anilist:ID o mal:ID)")
        ctx = self.context()
        try:
            provider, ident = uid.split(":")
            if provider == "anilist":
                entry = ctx.anilist.get(int(ident))
            else:
                got = ctx.anilist.fetch_ids(mal_ids=[int(ident)])
                entry = next(iter(got.values()), None) or ctx.jikan.anime(int(ident))
            if entry is None:
                raise ServiceError("Anime no encontrado", 404)
            cfg = parse_config({"catalog": {"name": "explorer"}})

            def fetch(uids: list[str]) -> dict[str, AnimeEntry]:
                ids = [int(u.split(":")[1]) for u in uids if u.startswith("anilist:")]
                return ctx.anilist.fetch_ids(ids) if ids else {}

            canon = CanonicalAnimeResolver(ctx.index, cfg.canonical, fetch, db=ctx.db, source_order=cfg.mapping.source_order())
            group = next(g for g in canon.resolve({entry.uid: entry}) if entry.uid in g.members)
            resolver = MappingResolver(ctx.db, ctx.index, cfg.mapping, ctx.tmdb, cache=ctx.cache)
            root = group.root
            res = resolver.resolve_entry(root, "movie" if root.format == "MOVIE" else "tv", check_year=True)
            own = resolver.resolve_entry(entry, "movie" if entry.format == "MOVIE" else "tv", check_year=entry.uid == root.uid)
            resolver.flush()
            override = ctx.db.get_override(entry.uid)
            review = next((r for r in ctx.db.list_review() if r["uid"] in (entry.uid, root.uid)), None)
            cands: dict[tuple[str, str, Any, str], list[Any]] = {}
            for c in res.candidates:
                route = str(c.get("via") or c.get("detail") or "").split(":")[0]
                cands.setdefault((str(c.get("source")), str(c.get("type")), c.get("tmdb_id"), route), []).append(c.get("season"))
            return {
                "entry": _entry_brief(entry),
                "entry_mapping": {"media_type": own.media_type, "tmdb_id": own.tmdb_id, "season": own.season, "status": own.status.value,
                                  "seasons": sorted({c["season"] for c in own.candidates if c.get("tmdb_id") == own.tmdb_id
                                                     and c.get("source") == own.source and c.get("season") is not None})},
                "canonical": _entry_brief(root),
                "members": [_entry_brief(m) for m in group.member_list()],
                "grouping": group.criteria,
                "mapping": {
                    "media_type": res.media_type, "tmdb_id": res.tmdb_id, "tvdb_id": res.tvdb_id, "imdb_id": res.imdb_id,
                    "anidb": res.external.anidb, "source": res.source, "status": res.status.value,
                    "confidence": round(res.confidence, 3), "addable": res.status in ADDABLE_STATUSES and bool(res.tmdb_id),
                    "validation": res.validation.model_dump(), "evidence": res.evidence, "conflicts": res.conflicts,
                    "tmdb_available": ctx.tmdb is not None,
                },
                "candidates": [{"source": k[0], "type": k[1], "tmdb_id": k[2], "route": k[3],
                                "seasons": sorted({s for s in v if s is not None})} for k, v in cands.items()],
                "override": override, "review": review, "dataset_versions": resolver.versions,
            }
        finally:
            ctx.close()

    def review(self, status: str, page: int, size: int) -> dict[str, Any]:
        ctx = self.context()
        try:
            return paginate(ctx.db.list_review(status or None), page, size)
        finally:
            ctx.close()

    def set_override(self, body: dict[str, Any]) -> dict[str, Any]:
        uid = str(body.get("uid") or "")
        if not re.match(r"^(anilist|mal):\d+$", uid):
            raise ServiceError("uid inválido (anilist:ID o mal:ID)")
        action = body.get("action")
        ctx = self.context()
        try:
            try:
                if action == "map":
                    ctx.db.set_override(uid, "map", body.get("media_type"), int(body.get("tmdb_id") or 0) or None, note=body.get("note"))
                elif action == "exclude":
                    ctx.db.set_override(uid, "exclude", note=body.get("note"))
                elif action == "canonical":
                    ctx.db.set_override(uid, "canonical", canonical_uid=body.get("canonical_uid"), note=body.get("note"))
                else:
                    raise ServiceError("Acción inválida (map, exclude, canonical)")
            except ValueError as err:
                raise ServiceError(str(err)) from err
            export_overrides(ctx.db, self.settings.overrides_path)
            return {"ok": True, "override": ctx.db.get_override(uid)}
        finally:
            ctx.close()

    def delete_override(self, uid: str) -> bool:
        ctx = self.context()
        try:
            ok = ctx.db.delete_override(uid)
            if ok:
                export_overrides(ctx.db, self.settings.overrides_path)
            return ok
        finally:
            ctx.close()

    # ------------------------------------------------------------------ MDBList
    def _mdb(self, ctx: AppContext):  # type: ignore[no-untyped-def]
        if ctx.mdblist is None:
            raise ServiceError("Configura MDBLIST_API_KEY en Ajustes para usar MDBList", 412)
        return ctx.mdblist

    def mdb_lists(self) -> list[dict[str, Any]]:
        ctx = self.context()
        try:
            lists = self._mdb(ctx).lists()
            managed = {r[0]: r[1] for r in ctx.db.conn.execute("SELECT list_id, COUNT(*) FROM managed_items GROUP BY list_id")}
            return [{"id": x.get("id"), "name": x.get("name"), "slug": x.get("slug"), "items": x.get("items"),
                     "private": x.get("private"), "managed": managed.get(x.get("id"), 0)} for x in lists]
        finally:
            ctx.close()

    def mdb_create(self, name: str, private: bool) -> dict[str, Any]:
        name = (name or "").strip()
        if not name:
            raise ServiceError("El nombre de la lista es obligatorio")
        ctx = self.context()
        try:
            client = self._mdb(ctx)
            if client.find_lists(name):
                raise ServiceError(f"Ya existe una lista llamada {name!r}", 409)
            created = client.create_list(name, private=private)
            return {"id": created.get("id"), "name": name}
        finally:
            ctx.close()

    def mdb_items(self, list_id: int, page: int, size: int, q: str = "", media: str = "") -> dict[str, Any]:
        ctx = self.context()
        try:
            items = self._mdb(ctx).list_items(list_id)
            managed = {(r[0], int(r[1])) for r in ctx.db.conn.execute(
                "SELECT media_type, tmdb_id FROM managed_items WHERE list_id=?", (list_id,))}
            rows = [{"type": k[0], "tmdb_id": k[1], "title": v.get("title"), "year": v.get("year"), "managed": k in managed}
                    for k, v in items.items()]
            if media:
                rows = [r for r in rows if r["type"] == media]
            if q:
                rows = [r for r in rows if q.casefold() in str(r["title"] or "").casefold() or q == str(r["tmdb_id"])]
            rows.sort(key=lambda r: str(r["title"] or "").casefold())
            return paginate(rows, page, size)
        finally:
            ctx.close()


def _entry_brief(e: AnimeEntry) -> dict[str, Any]:
    return {"uid": e.uid, "anilist_id": e.anilist_id, "mal_id": e.mal_id, "title": e.title, "romaji": e.title_romaji,
            "year": e.start_date.year, "start": str(e.start_date), "format": e.format, "status": e.status,
            "score": e.average_score, "episodes": e.episodes}


def _run_brief(r: dict[str, Any]) -> dict[str, Any]:
    stats = (r.get("summary") or {}).get("stats") or {}
    return {"run_id": r["run_id"], "catalog": r["catalog"], "mode": r.get("mode"), "dry_run": bool(r.get("dry_run")),
            "list_id": r.get("list_id"), "status": r.get("status"), "started_at": r.get("started_at"),
            "finished_at": r.get("finished_at"), "valid_titles": stats.get("valid_titles"), "new_titles": stats.get("new_titles"),
            "added": stats.get("added"), "errors": stats.get("sync_errors")}
