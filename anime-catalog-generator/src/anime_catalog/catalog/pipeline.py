"""Orquestación completa: fuente -> filtros -> serie canónica -> mapping -> validación ->
deduplicación -> MDBList -> reportes."""

from __future__ import annotations

import json
import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any

from ..config import CatalogConfig, MetadataScope, SyncMode, TemporalMode
from ..context import AppContext
from ..http import HttpError
from ..integrations.sync import SyncEngine, SyncPlan, SyncResult
from ..mapping.index import DATASET_CLASSES
from ..mapping.resolver import MappingResolver
from ..models import ADDABLE_STATUSES, BROADCAST_FORMATS, AnimeEntry, MappingStatus, ResolvedTitle
from ..providers.anilist import ServerFilters
from .canonical import CanonicalAnimeResolver, CanonicalGroup
from .deduplication import DeduplicationEngine, DuplicateRecord
from .filters import AnimeFilterEngine, Verdict
from .progress import NULL_PROGRESS, Cancelled, Progress
from .relations import compilation_parents

log = logging.getLogger(__name__)


@dataclass
class ExcludedItem:
    uid: str
    title: str
    year: int | None
    format: str | None
    stage: str  # temporal | metadata | mapping
    reasons: list[str]


@dataclass
class RunReport:
    run_id: str
    catalog: str
    description: str | None
    config: dict[str, Any]
    started_at: float
    finished_at: float = 0.0
    dry_run: bool = True
    stats: dict[str, int] = field(default_factory=dict)
    mapping_sources: dict[str, int] = field(default_factory=dict)
    titles: list[ResolvedTitle] = field(default_factory=list)  # únicos (todas las situaciones)
    excluded: list[ExcludedItem] = field(default_factory=list)
    duplicates: list[DuplicateRecord] = field(default_factory=list)
    plan: SyncPlan | None = None
    sync: SyncResult | None = None
    dataset_versions: dict[str, str] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    partitions: list[str] = field(default_factory=list)

    @property
    def addable(self) -> list[ResolvedTitle]:
        return [t for t in self.titles if t.addable]

    @property
    def review(self) -> list[ResolvedTitle]:
        return [t for t in self.titles if t.mapping_status not in ADDABLE_STATUSES]


def _expression_uses(expr: Any, attr: str) -> bool:
    """¿Algún bloque de la expresión AND/OR/NOT activa `attr`?"""
    if expr is None:
        return False
    for sub in getattr(expr, "and_", None) or getattr(expr, "or_", None) or []:
        if _expression_uses(sub, attr):
            return True
    if getattr(expr, "not_", None) is not None:
        return _expression_uses(expr.not_, attr)
    return bool(getattr(expr, attr, False))


def _idents(entries: Any) -> list[tuple[str, int]]:
    out: list[tuple[str, int]] = []
    for e in entries:
        if e.anilist_id:
            out.append(("anilist", e.anilist_id))
        if e.mal_id:
            out.append(("mal", e.mal_id))
    return out


def slugify(name: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", name).strip("-").lower()
    return s or "catalogo"


class CatalogPipeline:
    def __init__(self, ctx: AppContext, config: CatalogConfig, *, dry_run: bool, offline: bool = False,
                 confirm_replace: bool = False, today: date | None = None, progress: Progress | None = None):
        self.ctx = ctx
        self.progress = progress or NULL_PROGRESS
        self.cfg = config
        self.dry_run = dry_run
        self.offline = offline
        self.confirm_replace = confirm_replace
        self.today = today or date.today()
        self.filters = AnimeFilterEngine(config.filters, db=ctx.db, today=self.today)
        self.run_id = (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + slugify(config.catalog.name)[:40]
                       + "-" + uuid.uuid4().hex[:6])
        self.report = RunReport(
            run_id=self.run_id, catalog=config.catalog.name, description=config.catalog.description,
            config=json.loads(config.model_dump_json(by_alias=True)), started_at=time.time(), dry_run=dry_run,
        )
        self._mal_checked: set[str] = set()

    # ------------------------------------------------------------------ utilidades
    def _exclude(self, e: AnimeEntry, stage: str, reasons: list[str]) -> None:
        self.report.excluded.append(ExcludedItem(e.uid, e.title, e.start_date.year, e.format, stage, reasons))

    def _fetch_uids(self, uids: list[str]) -> dict[str, AnimeEntry]:
        anilist = [int(u.split(":")[1]) for u in uids if u.startswith("anilist:")]
        mal = [int(u.split(":")[1]) for u in uids if u.startswith("mal:")]
        out: dict[str, AnimeEntry] = {}
        if anilist:
            out.update(self.ctx.anilist.fetch_ids(anilist))
        if mal:
            out.update(self.ctx.jikan.fetch_ids(mal))
        return out

    def _server_filters(self) -> ServerFilters:
        f = self.cfg.filters
        safe_meta = f.temporal_mode == TemporalMode.ENTRY_RELEASE_YEAR or (
            f.temporal_mode == TemporalMode.ORIGINAL_RELEASE_YEAR and f.metadata_scope == MetadataScope.CANONICAL
        )
        formats = list(f.formats or [])
        if f.temporal_mode == TemporalMode.ANY_SEASON_RELEASE_YEAR and any(x in BROADCAST_FORMATS for x in formats):
            formats = sorted(set(formats) | BROADCAST_FORMATS)
        sf = ServerFilters(formats=formats or None)
        if safe_meta:
            if not f.include_adult:
                sf.is_adult = False
            # genre_in / tag_in de AniList exigen TODOS los valores (AND): solo se envían en modo AND.
            if f.genres and f.genres.include and (f.genres.mode == "AND" or len(f.genres.include) == 1):
                sf.genres = f.genres.include
            if f.genres and f.genres.exclude:
                sf.genres_not = f.genres.exclude
            if f.tags and f.tags.include and (f.tags.mode == "AND" or len(f.tags.include) == 1):
                sf.tags = f.tags.include
            if f.score and f.score.provider == "anilist" and f.score.field == "averageScore" and f.score.min is not None:
                sf.min_score = int(f.score.min) - 1
            if f.popularity and f.popularity.min is not None:
                sf.min_popularity = int(f.popularity.min) - 1
            if f.country and len(f.country.include) == 1:
                sf.country = f.country.include[0]
            if f.status and f.status.include and not f.status.exclude:
                sf.status = f.status.include
        return sf

    # ------------------------------------------------------------------ fases
    def ensure_mappings(self) -> None:
        wanted = [s for s in self.cfg.mapping.source_order() if s in DATASET_CLASSES and DATASET_CLASSES[s].enabled_by_default]
        if self.offline:
            missing = [s for s in wanted if not self.ctx.index.has_data(s)]
            if missing:
                self.report.notes.append(f"modo offline: sin índice para {missing}")
            return
        for r in self.ctx.updater.ensure(wanted):
            if r.status == "failed":
                self.report.errors.append(f"dataset {r.source}: {r.message}")
        for s in self.cfg.mapping.source_order():
            if s in DATASET_CLASSES and not self.ctx.index.has_data(s):
                self.report.notes.append(
                    f"la fuente {s} no está descargada (ejecuta `anime-catalog mappings update --source {s}` para usarla)"
                )

    def fetch_seeds(self) -> dict[str, AnimeEntry]:
        f = self.cfg.filters
        pr = self.progress
        pr.phase("Consultando " + ("MyAnimeList (Jikan)" if self.cfg.source.primary == "myanimelist" else "AniList"), None)
        lo, hi = f.date_bounds()
        seeds: dict[str, AnimeEntry] = {}
        primary = self.cfg.source.primary
        if primary in ("anilist", "hybrid"):
            if f.studios and f.studios.include and lo is None and hi is None:
                for name in f.studios.include:
                    for e in self.ctx.anilist.iter_studio(name):
                        seeds[e.uid] = e
                        pr.advance(1)
                        pr.check()
                self.report.notes.append(f"consulta por estudio(s) {f.studios.include} (sin rango de fechas)")
            else:
                for e in self.ctx.anilist.iter_range(lo, hi, self._server_filters()):
                    seeds[e.uid] = e
                    pr.advance(1)
                    pr.check()
            self.report.partitions = list(self.ctx.anilist.partitions)
            self.report.stats["anilist_pages"] = self.ctx.anilist.pages_fetched
        else:
            sfw = not f.include_adult
            for e in self.ctx.jikan.iter_range(lo, hi, f.formats, sfw=sfw):
                seeds[e.uid] = e
                pr.advance(1)
                pr.check()
            self.report.stats["jikan_pages"] = self.ctx.jikan.pages_fetched
        return seeds

    def _ensure_mal(self, e: AnimeEntry) -> None:
        """Modo híbrido: completa la puntuación de MAL mediante Jikan (sin mezclarla con la de AniList)."""
        if not self.cfg.source.enrich_mal_scores or e.provider != "anilist" or not e.mal_id or e.uid in self._mal_checked:
            return
        self._mal_checked.add(e.uid)
        if e.mal_score is not None:
            return
        try:
            s = self.ctx.jikan.scores(e.mal_id)
        except HttpError as err:
            self.report.errors.append(f"Jikan mal:{e.mal_id}: {err}")
            return
        if s:
            e.mal_score, e.mal_scored_by, e.mal_members = s.get("score"), s.get("scored_by"), s.get("members")

    def _metadata(self, e: AnimeEntry) -> Verdict:
        self._ensure_mal(e)
        return self.filters.metadata(e)

    def _prefetch_compilation_parents(self, entries: list[AnimeEntry]) -> None:
        f = self.cfg.filters
        if not (f.exclude_compilations or _expression_uses(f.expression, "exclude_compilations")):
            return
        want = sorted({p for e in entries for p in compilation_parents(e)})
        if want:
            got = self._fetch_uids(want)
            self.filters.known.update(got)

    def select_groups(self, seeds: dict[str, AnimeEntry]) -> list[tuple[CanonicalGroup, list[AnimeEntry]]]:
        """Devuelve (grupo, semillas que lo originan) que cumplen los filtros según el modo temporal."""
        f = self.cfg.filters
        mode = f.temporal_mode
        canonical = CanonicalAnimeResolver(self.ctx.index, self.cfg.canonical, self._fetch_uids, db=self.ctx.db,
                                           source_order=self.cfg.mapping.source_order())
        self.filters.known = dict(seeds)
        selected: list[tuple[CanonicalGroup, list[AnimeEntry]]] = []

        if mode == TemporalMode.ENTRY_RELEASE_YEAR:
            self._prefetch_compilation_parents(list(seeds.values()))
            passing: dict[str, AnimeEntry] = {}
            self.progress.phase("Aplicando filtros", len(seeds))
            for uid, e in seeds.items():
                self.progress.advance(1)
                tv = self.filters.temporal(e)
                if not tv:
                    self._exclude(e, "temporal", tv.reasons)
                    continue
                mv = self._metadata(e)
                if not mv:
                    self._exclude(e, "metadata", mv.reasons)
                    continue
                passing[uid] = e
            self.report.stats["filtered"] = len(passing)
            if not self.cfg.canonical.enabled:
                return [(CanonicalGroup(root=e, members={u: e}, criteria=["sin resolución canónica"],
                                        kind="movie" if e.format == "MOVIE" else "series"), [e]) for u, e in passing.items()]
            self.ctx.index.prefetch(_idents(passing.values()))
            self.progress.phase("Agrupando temporadas (serie canónica)", None)
            groups = canonical.resolve(passing)
            self.report.stats["extra_fetched"] = canonical.fetched_extra
            for g in groups:
                origin = [m for u, m in g.members.items() if u in passing]
                if origin:
                    selected.append((g, origin))
            return selected

        # ORIGINAL / ANY_SEASON: primero se agrupa y después se evalúa la serie.
        pruned: dict[str, AnimeEntry] = {}
        formats = set(f.formats or [])
        for uid, e in seeds.items():
            if e.format in ("MOVIE", "MUSIC") and e.format not in formats:
                self._exclude(e, "metadata", [f"formato {e.format} no está en {sorted(formats)}"])
                continue
            pruned[uid] = e
        self.ctx.index.prefetch(_idents(pruned.values()))
        self.progress.phase("Agrupando temporadas (serie canónica)", None)
        groups = canonical.resolve(pruned)
        self.report.stats["extra_fetched"] = canonical.fetched_extra
        roots = [g.root for g in groups]
        self.filters.known.update({m.uid: m for g in groups for m in g.members.values()})
        self._prefetch_compilation_parents(roots)
        passed = 0
        self.progress.phase("Aplicando filtros", len(groups))
        for g in groups:
            self.progress.advance(1)
            self.progress.check()
            origin = [m for u, m in g.members.items() if u in pruned]
            if not origin:
                continue
            if mode == TemporalMode.ORIGINAL_RELEASE_YEAR:
                tv = self.filters.temporal(g.root)
                treasons = tv.reasons
            else:
                cands = [m for m in g.member_list() if g.kind != "series" or m.format in BROADCAST_FORMATS] or g.member_list()
                verdicts = [self.filters.temporal(m) for m in cands]
                tv = Verdict(any(verdicts), [] if any(verdicts) else [f"ninguna temporada en el intervalo ({'; '.join(verdicts[0].reasons) if verdicts else ''})"])
                treasons = tv.reasons
            if not tv:
                self._exclude(g.root, "temporal", [f"[serie canónica] {r}" for r in treasons]
                              + ([f"agrupa: {', '.join(m.uid for m in g.member_list())}"] if len(g.members) > 1 else []))
                continue
            if f.metadata_scope == MetadataScope.ANY_MEMBER:
                mvs = [self._metadata(m) for m in g.member_list()]
                mv = Verdict(any(mvs), [] if any(mvs) else [f"ninguna temporada cumple: {mvs[0].reasons}"])
            else:
                mv = self._metadata(g.root)
            if not mv:
                self._exclude(g.root, "metadata", mv.reasons)
                continue
            passed += 1
            selected.append((g, origin))
        self.report.stats["filtered"] = passed
        return selected

    def resolve_mappings(self, selected: list[tuple[CanonicalGroup, list[AnimeEntry]]]) -> list[ResolvedTitle]:
        resolver = MappingResolver(self.ctx.db, self.ctx.index, self.cfg.mapping, self.ctx.tmdb, cache=self.ctx.cache)
        chunk = 400
        self.report.dataset_versions = resolver.versions
        out: list[ResolvedTitle] = []
        first_only = self.cfg.canonical.first_only
        self.progress.phase("Resolviendo mappings (AniBridge → Kometa → Fribb)", len(selected))
        for n, (g, origin) in enumerate(selected):
            self.progress.advance(1, g.root.title)
            self.progress.check()
            if n % chunk == 0:
                # Precarga por bloques: índice, caché persistente y TMDB concurrente; memoria acotada.
                self.ctx.index.clear_cache()
                block = selected[n : n + chunk]
                resolver.prefetch(list({m.uid: m for bg, _ in block for m in [bg.root, *bg.members.values()]}.values()))
            targets = [g.root] if first_only else sorted(origin, key=lambda m: m.start_date.sort_key())
            for subject in targets:
                is_root = subject.uid == g.root.uid
                prefer = "movie" if subject.format == "MOVIE" else "tv"
                res = resolver.resolve_entry(subject, prefer, check_year=is_root)
                evidence_extra: list[str] = []
                if res.tmdb_id is None and res.status in (MappingStatus.UNMAPPED,) and len(g.members) > 1:
                    for m in g.member_list():
                        if m.uid == subject.uid or (g.kind == "series" and m.format not in BROADCAST_FORMATS):
                            continue
                        mr = resolver.resolve_entry(m, prefer, check_year=False)
                        if mr.tmdb_id and mr.status in ADDABLE_STATUSES:
                            res.media_type, res.tmdb_id = mr.media_type, mr.tmdb_id
                            res.source = mr.source
                            res.tvdb_id, res.imdb_id = mr.tvdb_id, mr.imdb_id
                            res.confidence = max(0.0, mr.confidence - 0.05)
                            res.status = (MappingStatus.HIGH_CONFIDENCE if res.confidence >= self.cfg.mapping.minimum_confidence
                                          else MappingStatus.NEEDS_REVIEW)
                            evidence_extra.append(f"ID inferido desde la temporada {m.uid} ({m.title}) del mismo grupo")
                            break
                if g.kind == "series" and res.season and res.season > 1 and is_root:
                    evidence_extra.append(f"aviso: la entrada original corresponde a la temporada {res.season} en TMDB")
                if len(g.show_ids) > 1:
                    evidence_extra.append(f"aviso: el grupo referencia varias series TMDB {sorted(g.show_ids)}")
                rt = resolver.to_resolved(subject, res, members=[m.uid for m in g.member_list()], grouping=g.criteria)
                rt.evidence = rt.evidence + evidence_extra
                resolver.persist(rt, res)
                self.ctx.repo.save_canonical(g.uid, g.root.start_date.year, [m.uid for m in g.member_list()], g.criteria)
                if rt.mapping_status in (MappingStatus.NEEDS_REVIEW, MappingStatus.CONFLICT, MappingStatus.UNMAPPED):
                    self.ctx.db.queue_review(rt.canonical_uid, rt.title, rt.mapping_status.value,
                                             "; ".join(rt.conflicts or rt.evidence[-2:]), res.candidates[:20], self.cfg.catalog.name)
                elif rt.addable:
                    self.ctx.db.clear_review(rt.canonical_uid)
                out.append(rt)
        resolver.flush()
        self.report.stats["mapping_cache_hits"] = resolver.stats["persistent_hits"]
        self.report.stats["tmdb_prefetched"] = resolver.stats["tmdb_prefetched"]
        return out

    def _sort_and_limit(self, titles: list[ResolvedTitle], entries: dict[str, AnimeEntry]) -> list[ResolvedTitle]:
        f = self.cfg.filters

        def key(t: ResolvedTitle) -> Any:
            e = entries.get(t.canonical_uid)
            if f.sort == "score":
                return (e.average_score if e and e.average_score is not None else -1)
            if f.sort == "popularity":
                return e.popularity if e and e.popularity is not None else -1
            if f.sort == "favourites":
                return e.favourites if e and e.favourites is not None else -1
            if f.sort == "title":
                return t.title.casefold()
            return e.start_date.sort_key() if e else (9999, 13, 32)

        ordered = sorted(titles, key=key, reverse=f.order == "desc")
        if f.limit:
            addable = [t for t in ordered if t.addable][: f.limit]
            keep = {id(t) for t in addable}
            dropped = [t for t in ordered if t.addable and id(t) not in keep]
            for t in dropped:
                self.report.excluded.append(ExcludedItem(t.canonical_uid, t.title, t.canonical_year, t.canonical_format, "limit",
                                                         [f"fuera del límite de {f.limit} resultados (orden {f.sort} {f.order})"]))
            ordered = [t for t in ordered if not t.addable or id(t) in keep]
        return ordered

    # ------------------------------------------------------------------ ejecución
    def run(self) -> RunReport:
        rep = self.report
        db = self.ctx.db
        db.conn.execute(
            "INSERT INTO runs(run_id, catalog, list_name, mode, dry_run, started_at, status) VALUES(?,?,?,?,?,?,?)",
            (self.run_id, self.cfg.catalog.name, self.cfg.catalog.name, self.cfg.mdblist.mode.value, int(self.dry_run),
             rep.started_at, "running"),
        )
        try:
            self.progress.phase("Comprobando datasets de mappings", None)
            self.ensure_mappings()
            seeds = self.fetch_seeds()
            rep.stats["found"] = len(seeds)
            selected = self.select_groups(seeds)
            rep.stats["canonical_series"] = len(selected)
            rep.stats["seasons_grouped"] = sum(len(g.members) - 1 for g, _ in selected if g.kind == "series")
            resolved = self.resolve_mappings(selected)
            dd = DeduplicationEngine(self.cfg.duplicates.dedupe_by_tmdb_id, self.cfg.duplicates.dedupe_by_canonical_anime)
            result = dd.run(resolved) if self.cfg.duplicates.enabled else None
            unique = result.unique if result else resolved
            rep.duplicates = result.duplicates if result else []
            entries = {g.root.uid: g.root for g, _ in selected}
            entries.update({m.uid: m for g, _ in selected for m in g.members.values()})
            rep.titles = self._sort_and_limit(unique, entries)
            self._count_sources()
            self.progress.pending([f"{t.title} ({t.mapping_status.value})" for t in rep.review][:200])
            self._sync()
            rep.finished_at = time.time()
            status = "interrupted" if rep.sync and rep.sync.interrupted else "ok"
            if rep.sync and rep.sync.cancelled:
                status = "cancelled"
        except Cancelled:
            rep.errors.append("cancelado por el usuario")
            rep.finished_at = time.time()
            self._finish("cancelled")
            raise
        except Exception as err:
            rep.errors.append(f"{type(err).__name__}: {err}")
            rep.finished_at = time.time()
            status = "failed"
            self._finish(status)
            raise
        self._finish(status)
        return rep

    def _count_sources(self) -> None:
        rep = self.report
        counts: dict[str, int] = {}
        for t in rep.titles:
            if t.addable and t.mapping_source:
                counts[t.mapping_source] = counts.get(t.mapping_source, 0) + 1
        rep.mapping_sources = counts
        rep.stats["valid_titles"] = len(rep.addable)
        rep.stats["unmapped"] = sum(1 for t in rep.titles if t.mapping_status == MappingStatus.UNMAPPED)
        rep.stats["needs_review"] = sum(1 for t in rep.titles if t.mapping_status == MappingStatus.NEEDS_REVIEW)
        rep.stats["conflicts"] = sum(1 for t in rep.titles if t.mapping_status == MappingStatus.CONFLICT)
        rep.stats["excluded_override"] = sum(1 for t in rep.titles if t.mapping_status == MappingStatus.EXCLUDED)
        rep.stats["fallback"] = sum(v for k, v in counts.items() if k in ("tmdb_find", "title_search"))
        rep.stats["tv"] = sum(1 for t in rep.addable if t.media_type == "tv")
        rep.stats["movies"] = sum(1 for t in rep.addable if t.media_type == "movie")
        rep.stats["duplicates_removed"] = sum(len(d.dropped) for d in rep.duplicates if d.kind != "season_group")

    def _sync(self) -> None:
        rep = self.report
        mcfg = self.cfg.mdblist
        engine = SyncEngine(self.ctx.db, mcfg, self.ctx.mdblist, catalog=self.cfg.catalog.name, run_id=self.run_id)
        if self.ctx.mdblist is None and not self.dry_run:
            raise RuntimeError("Falta MDBLIST_API_KEY: no se puede escribir en MDBList (usa --dry-run para simular)")
        self.progress.phase("Leyendo la lista de MDBList y calculando diferencias", None)
        plan = engine.plan(self.cfg.catalog.name, rep.addable, self.dry_run)
        rep.plan = plan
        rep.stats["already_in_list"] = len(plan.already_present)
        rep.stats["new_titles"] = len(plan.to_add)
        rep.stats["to_remove"] = len(plan.to_remove)
        if self.dry_run:
            rep.notes.append("DRY-RUN: no se ha modificado MDBList")
            return
        if mcfg.mode == SyncMode.REPLACE and plan.to_remove and not self.confirm_replace:
            raise RuntimeError(
                f"replace eliminaría {len(plan.to_remove)} elemento(s); revisa la vista previa (--dry-run) y repite con --confirm-replace"
            )
        self.progress.phase("Sincronizando con MDBList", len(plan.to_add) + len(plan.to_remove))
        res = engine.apply(plan, confirm_replace=self.confirm_replace, private=mcfg.private, progress=self.progress)
        engine.touch_managed(plan)
        rep.sync = res
        rep.stats["added"] = len(res.added)
        rep.stats["removed"] = len(res.removed)
        rep.stats["sync_errors"] = len(res.errors) + len(res.not_found)
        rep.errors += res.errors
        rep.errors += [f"MDBList no encontró {m}:{t}" for m, t in res.not_found]

    def _finish(self, status: str) -> None:
        rep = self.report
        plan_list = rep.plan.list_id if rep.plan else None
        if rep.sync and rep.sync.list_id:
            plan_list = rep.sync.list_id
        summary = {"stats": rep.stats, "mapping_sources": rep.mapping_sources, "errors": rep.errors[:50]}
        self.ctx.db.conn.execute(
            "UPDATE runs SET finished_at=?, status=?, summary=?, dataset_versions=?, list_id=? WHERE run_id=?",
            (rep.finished_at, status, json.dumps(summary, ensure_ascii=False), json.dumps(rep.dataset_versions), plan_list, self.run_id),
        )
