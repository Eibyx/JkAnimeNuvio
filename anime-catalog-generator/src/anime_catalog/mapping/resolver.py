"""MappingResolver: AniList/MAL -> TMDB (serie o película) con prioridad de fuentes, índices
inversos, puente vía AniDB, validación en TMDB, fallbacks por IDs externos y por título, y overrides.

Reglas clave:
- Las fuentes se consultan en el orden configurado (por defecto AniBridge, Kometa, Fribb, Anime-Lists).
- Los descriptores `tmdb_show:X:sN` aportan el ID de serie X; la temporada solo se usa para interpretar.
- Las discrepancias se comparan dentro del mismo tipo (serie con serie, película con película):
  que AniBridge dé una película y Fribb la ubique como especial (s0) de una serie es una diferencia
  de representación, no un conflicto de identidad.
- Las confirmaciones de fuentes con la misma procedencia (lineage) no cuentan como independientes.
- Un conflicto no resuelto, o una confianza inferior al mínimo, nunca se añade a MDBList.
"""

from __future__ import annotations

import json
import logging
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Literal

from ..config import MappingConfig
from ..http import HttpError
from ..models import (
    AnimeEntry,
    ExternalIds,
    MappingCandidate,
    MappingStatus,
    MediaType,
    ResolvedTitle,
    ValidationResult,
)
from ..providers.tmdb import TMDBClient
from ..storage.database import Database
from .index import DATASET_CLASSES, IndexHit, MappingIndex, season_of
from .titles import best_similarity

log = logging.getLogger(__name__)

CONFIRMED_THRESHOLD = 0.97
ANIMATION_GENRE = 16
EAST_ASIAN_LANGS = {"ja", "zh", "ko", "cn"}

SOURCE_CONFIDENCE = {name: cls.base_confidence for name, cls in DATASET_CLASSES.items()}
SOURCE_LINEAGE = {name: cls.lineage for name, cls in DATASET_CLASSES.items()}
SOURCE_CONFIDENCE.update({"tmdb_find": 0.85, "override": 1.0})


@dataclass
class EntryResolution:
    uid: str
    media_type: MediaType | None = None
    tmdb_id: int | None = None
    season: int | None = None
    source: str | None = None
    status: MappingStatus = MappingStatus.UNMAPPED
    confidence: float = 0.0
    evidence: list[str] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)
    candidates: list[dict[str, Any]] = field(default_factory=list)
    external: ExternalIds = field(default_factory=ExternalIds)
    validation: ValidationResult = field(default_factory=ValidationResult)
    tvdb_id: int | None = None
    imdb_id: str | None = None


def _tier(c: MappingCandidate) -> int:
    if c.via.startswith("vía anidb"):
        return 2
    return 1 if c.reverse else 0


def _media_type(provider: str) -> MediaType | None:
    if provider == "tmdb_show":
        return "tv"
    if provider == "tmdb_movie":
        return "movie"
    return None


class MappingResolver:
    def __init__(self, db: Database, index: MappingIndex, config: MappingConfig, tmdb: TMDBClient | None = None):
        self.db = db
        self.index = index
        self.config = config
        self.tmdb = tmdb
        self.versions = index.dataset_versions()
        self._entry_cache: dict[tuple[str, str, bool], EntryResolution] = {}

    @property
    def dataset_sources(self) -> list[str]:
        return [s for s in self.config.source_order() if s in DATASET_CLASSES]

    # ------------------------------------------------------------------ candidatos
    def _idents(self, entry: AnimeEntry) -> list[tuple[str, int]]:
        out = []
        if entry.anilist_id:
            out.append(("anilist", entry.anilist_id))
        if entry.mal_id:
            out.append(("mal", entry.mal_id))
        return out

    def collect(self, entry: AnimeEntry) -> tuple[list[MappingCandidate], ExternalIds, list[str]]:
        """Reúne candidatos TMDB y los IDs externos de todas las fuentes de datasets habilitadas."""
        sources = self.dataset_sources
        cands: list[MappingCandidate] = []
        ext = ExternalIds()
        notes: list[str] = []
        anidb_ids: set[int] = set()
        hits: list[tuple[IndexHit, str]] = []  # (hit, vía)
        for provider, ident in self._idents(entry):
            for h in self.index.forward(provider, ident, sources):
                hits.append((h, "directo"))
                if h.dst_provider == "anidb" and h.dst_id.isdigit():
                    anidb_ids.add(int(h.dst_id))
            for h in self.index.reverse(provider, ident, sources):
                hits.append((h, "inverso"))
        for a in sorted(anidb_ids):
            for h in self.index.forward("anidb", a, sources):
                hits.append((h, f"vía anidb:{a}"))
        seen: set[tuple[str, str, str, str | None, str]] = set()
        for h, via in hits:
            key = (h.source, h.dst_provider if not h.reverse else h.src_provider, h.dst_id if not h.reverse else h.src_id,
                   h.dst_scope if not h.reverse else h.src_scope, via)
            if key in seen:
                continue
            seen.add(key)
            prov, ident, scope = (h.src_provider, h.src_id, h.src_scope) if h.reverse else (h.dst_provider, h.dst_id, h.dst_scope)
            mt = _media_type(prov)
            detail = h.detail or ""
            if mt and ident.isdigit():
                weight = 1.0
                if "eps=" in detail:
                    try:
                        weight = float(detail.split("eps=")[1].split(";")[0]) or 1.0
                    except ValueError:
                        weight = 1.0
                cands.append(
                    MappingCandidate(
                        media_type=mt, tmdb_id=int(ident), season=season_of(scope), source=h.source,
                        via=f"{via}: {h.describe()}", lineage=SOURCE_LINEAGE.get(h.source, frozenset()),
                        reverse=via == "inverso", weight=weight if "multi" not in detail else weight * 0.5,
                    )
                )
            elif prov == "tvdb_show" and ident.isdigit():
                if int(ident) not in ext.tvdb_show:
                    ext.tvdb_show.append(int(ident))
            elif prov == "tvdb_movie" and ident.isdigit():
                if int(ident) not in ext.tvdb_movie:
                    ext.tvdb_movie.append(int(ident))
            elif prov in ("imdb", "imdb_movie", "imdb_show") and ident.startswith("tt"):
                if ident not in ext.imdb:
                    ext.imdb.append(ident)
            elif prov == "anidb" and ident.isdigit():
                if int(ident) not in ext.anidb:
                    ext.anidb.append(int(ident))
            if "multi" in detail and h.source == "kometa":
                notes.append(f"kometa: la entrada AniDB agrupa varios IDs ({h.describe()})")
        return cands, ext, notes

    # ------------------------------------------------------------------ resolución por entrada
    def resolve_entry(self, entry: AnimeEntry, prefer: MediaType | None = None, check_year: bool = True) -> EntryResolution:
        prefer = prefer or ("movie" if entry.format == "MOVIE" else "tv")
        ck = (entry.uid, prefer, check_year)
        if ck in self._entry_cache:
            return self._entry_cache[ck]
        res = self._resolve_entry(entry, prefer, check_year)
        self._entry_cache[ck] = res
        return res

    def _resolve_entry(self, entry: AnimeEntry, prefer: MediaType, check_year: bool) -> EntryResolution:
        res = EntryResolution(uid=entry.uid)
        override = self.db.get_override(entry.uid)
        if override:
            if override["action"] == "exclude":
                res.status = MappingStatus.EXCLUDED
                res.source = "override"
                res.evidence.append(f"override manual: excluido ({override.get('note') or 'sin nota'})")
                return res
            if override["action"] == "map":
                res.media_type = override["media_type"]
                res.tmdb_id = int(override["tmdb_id"])
                res.source = "override"
                res.confidence = 1.0
                res.status = MappingStatus.CONFIRMED
                res.evidence.append(f"override manual: {res.media_type}:{res.tmdb_id} ({override.get('note') or 'sin nota'})")
                _, res.external, _ = self.collect(entry)
                self._fill_external(res)
                return res

        cands, ext, notes = self.collect(entry)
        res.external = ext
        res.evidence += notes
        res.candidates = [
            {"type": c.media_type, "tmdb_id": c.tmdb_id, "season": c.season, "source": c.source, "via": c.via}
            for c in cands
        ]
        chosen = self._choose(entry, cands, prefer, res)
        if chosen is None and res.status != MappingStatus.CONFLICT:
            chosen = self._fallback_external(entry, ext, prefer, res)
        if chosen is None and res.status not in (MappingStatus.CONFLICT, MappingStatus.NEEDS_REVIEW) and self.config.allow_title_search:
            chosen = self._fallback_title(entry, prefer, res)
        if chosen is None:
            if res.status == MappingStatus.UNMAPPED:
                res.evidence.append("sin correspondencia fiable en ninguna fuente")
            return res
        res.media_type, res.tmdb_id = chosen
        self._validate(entry, res, check_year)
        self._finalize(res)
        self._fill_external(res)
        return res

    def _choose(self, entry: AnimeEntry, cands: list[MappingCandidate], prefer: MediaType, res: EntryResolution) -> tuple[MediaType, int] | None:
        if not cands:
            return None
        by_type: dict[str, list[MappingCandidate]] = defaultdict(list)
        for c in cands:
            by_type[c.media_type].append(c)
        media_type: MediaType = prefer
        penalty = 0.0
        if not by_type.get(prefer):
            other: MediaType = "tv" if prefer == "movie" else "movie"
            if prefer == "movie" and not self.config.movie_allow_show_mapping:
                shows = sorted({(c.tmdb_id, c.season) for c in by_type[other]})
                res.status = MappingStatus.NEEDS_REVIEW
                res.evidence.append(
                    "película representada en los mappings solo como serie/temporada "
                    f"{['tv:%s:s%s' % s for s in shows]}; no se convierte automáticamente en serie"
                )
                return None
            media_type = other
            penalty = 0.15
            res.evidence.append(f"no hay candidatos de tipo {prefer}; se usa {other} con penalización")
        pool = by_type[media_type]

        # IDs propuestos por cada fuente. Dentro de una fuente solo se usa el mejor nivel disponible:
        # directo (AniList/MAL -> TMDB) > inverso (TMDB -> AniList/MAL) > puente vía AniDB.
        per_source: dict[str, dict[int, float]] = {}
        per_source_tier: dict[str, int] = {}
        for src in self.dataset_sources:
            mine = [c for c in pool if c.source == src]
            if not mine:
                continue
            tier = min(_tier(c) for c in mine)
            weights: dict[int, float] = defaultdict(float)
            for c in mine:
                if _tier(c) == tier:
                    weights[c.tmdb_id] += c.weight
            per_source[src] = dict(weights)
            per_source_tier[src] = tier
        if not per_source:
            return None

        primary = next(iter(per_source))
        weights = per_source[primary]
        if len(weights) > 1:
            total = sum(weights.values())
            best_id, best_w = max(weights.items(), key=lambda kv: kv[1])
            if prefer == "movie" or best_w / total < 0.8:
                res.status = MappingStatus.CONFLICT
                res.conflicts.append(f"{primary} propone varios {media_type}: {sorted(weights)}")
                return None
            res.evidence.append(f"{primary}: varias series candidatas, se elige {best_id} ({best_w:.0f}/{total:.0f} episodios)")
            chosen_id = best_id
        else:
            chosen_id = next(iter(weights))

        conf = SOURCE_CONFIDENCE.get(primary, 0.8) - penalty
        tier = per_source_tier[primary]
        via = next(c.via for c in pool if c.source == primary and c.tmdb_id == chosen_id and _tier(c) == tier)
        if tier == 1:
            conf -= 0.05
            res.evidence.append(f"{primary}: solo existe la relación inversa; se usa el índice inverso")
        elif tier == 2:
            conf -= 0.03
        res.evidence.append(f"elegido {media_type}:{chosen_id} por {primary} ({via})")
        lineage_union = set(SOURCE_LINEAGE.get(primary, frozenset()))
        disagreements: dict[str, list[int]] = {}
        for src, w in per_source.items():
            if src == primary:
                continue
            if chosen_id in w:
                new = set(SOURCE_LINEAGE.get(src, frozenset())) - lineage_union
                conf += 0.03 if new else 0.01
                lineage_union |= SOURCE_LINEAGE.get(src, frozenset())
                res.evidence.append(
                    f"{src} coincide" + ("" if new else " (misma procedencia: no cuenta como confirmación independiente)")
                )
            else:
                tier_s = per_source_tier[src]
                alt = [c for c in pool if c.source == src and _tier(c) == tier_s]
                chosen_season = next((c.season for c in pool if c.source == primary and c.tmdb_id == chosen_id), None)
                if media_type == "tv" and alt and all(c.season == 0 for c in alt) and (chosen_season or 0) >= 1:
                    # El respaldo solo la ubica como especial (s0) de otra serie, mientras que la fuente
                    # principal le da una serie propia: diferencia de representación, no de identidad.
                    conf -= 0.02
                    res.evidence.append(
                        f"{src} la ubica como especial s0 de tv:{sorted(w)}; {primary} la trata como serie propia "
                        f"tv:{chosen_id} (diferencia de representación, no conflicto)"
                    )
                    continue
                disagreements[src] = sorted(w)
        res.source = primary
        res.confidence = min(conf, 0.99)
        res.season = next((c.season for c in pool if c.source == primary and c.tmdb_id == chosen_id and c.season is not None), None)
        if disagreements:
            for src, ids in disagreements.items():
                res.conflicts.append(f"{src} propone {media_type}:{ids} frente a {media_type}:{chosen_id} de {primary}")
            alt = sorted({i for ids in disagreements.values() for i in ids} - {chosen_id})
            winner = self._resolve_conflict_by_validation(entry, media_type, [chosen_id, *alt], res)
            if winner is None:
                res.status = MappingStatus.CONFLICT
                return None
            if winner != chosen_id:
                res.source = next(s for s, ids in disagreements.items() if winner in ids)
                res.evidence.append(f"la validación en TMDB favorece {media_type}:{winner} ({res.source})")
            res.confidence = min(res.confidence, SOURCE_CONFIDENCE.get(res.source or primary, 0.85)) - 0.04
            chosen_id = winner
        return media_type, chosen_id

    def _resolve_conflict_by_validation(self, entry: AnimeEntry, media_type: MediaType, ids: list[int], res: EntryResolution) -> int | None:
        if not (self.tmdb and self.config.verify_tmdb):
            res.conflicts.append("sin TMDB para desempatar: queda pendiente de revisión")
            return None
        ok: list[int] = []
        for i in ids:
            v = self.validate_ids(entry, media_type, i, res.external, check_year=True)
            res.evidence.append(f"desempate {media_type}:{i}: {v.checks}")
            if v.ok and v.confidence_delta >= 0:
                ok.append(i)
        if len(ok) == 1:
            return ok[0]
        res.conflicts.append(f"la validación no desempata ({len(ok)} candidatos válidos)")
        return None

    # ------------------------------------------------------------------ fallbacks
    def _fallback_external(self, entry: AnimeEntry, ext: ExternalIds, prefer: MediaType, res: EntryResolution) -> tuple[MediaType, int] | None:
        if "tmdb" not in self.config.fallbacks or not self.tmdb or not (ext.tvdb_show or ext.imdb):
            return None
        found: dict[int, list[str]] = defaultdict(list)
        key = "tv_results" if prefer == "tv" else "movie_results"
        try:
            for t in ext.tvdb_show:
                for r in self.tmdb.find(str(t), "tvdb_id").get(key, []):
                    found[r["id"]].append(f"tvdb:{t}")
            for i in ext.imdb:
                for r in self.tmdb.find(i, "imdb_id").get(key, []):
                    found[r["id"]].append(f"imdb:{i}")
        except HttpError as err:
            res.evidence.append(f"TMDB /find falló: {err}")
            return None
        if not found:
            res.evidence.append(f"TMDB /find sin resultados {prefer} para {ext.tvdb_show + ext.imdb}")
            return None
        if len(found) > 1:
            res.status = MappingStatus.CONFLICT
            res.conflicts.append(f"TMDB /find devuelve varios candidatos: {dict(found)}")
            return None
        tmdb_id, why = next(iter(found.items()))
        res.source = "tmdb_find"
        res.confidence = SOURCE_CONFIDENCE["tmdb_find"]
        res.evidence.append(f"TMDB /find {why} -> {prefer}:{tmdb_id}")
        return prefer, tmdb_id

    def _fallback_title(self, entry: AnimeEntry, prefer: MediaType, res: EntryResolution) -> tuple[MediaType, int] | None:
        if "tmdb" not in self.config.fallbacks or not self.tmdb:
            return None
        year = entry.start_date.year
        queries = [t for t in (entry.title_romaji, entry.title_english, entry.title_native) if t][:3]
        results: dict[int, dict[str, Any]] = {}
        try:
            for q in queries:
                for r in self.tmdb.search(prefer, q, year):
                    if r.get("id"):
                        results.setdefault(r["id"], r)
        except HttpError as err:
            res.evidence.append(f"búsqueda TMDB falló: {err}")
            return None
        scored = []
        for r in results.values():
            sim, a, b = best_similarity(entry.all_titles(), [x for x in (r.get("name"), r.get("original_name")) if x])
            ry = int(r["date"][:4]) if r.get("date") and r["date"][:4].isdigit() else None
            ys = 1.0 if (ry and year and ry == year) else 0.5 if (ry and year and abs(ry - year) == 1) else 0.0
            anim = 1.0 if ANIMATION_GENRE in r.get("genre_ids", []) else 0.0
            jp = 1.0 if (r.get("original_language") in EAST_ASIAN_LANGS or "JP" in (r.get("origin_country") or [])) else 0.0
            score = 0.6 * sim + 0.2 * ys + 0.1 * anim + 0.1 * jp
            scored.append((score, r["id"], f"{r.get('name')} ({ry}) sim={sim:.2f} año={ys} anim={anim} jp={jp}"))
        scored.sort(reverse=True)
        res.candidates += [{"type": prefer, "tmdb_id": i, "source": "title_search", "score": round(s, 3), "detail": d} for s, i, d in scored[:5]]
        if not scored:
            res.evidence.append("búsqueda por título sin resultados")
            return None
        top = scored[0]
        gap = top[0] - (scored[1][0] if len(scored) > 1 else 0.0)
        res.source = "title_search"
        if top[0] >= 0.95 and gap >= 0.15:
            res.confidence = 0.92
        else:
            res.confidence = min(0.8, top[0] * 0.8)
            res.status = MappingStatus.NEEDS_REVIEW
            if gap < 0.15:
                res.conflicts.append(f"búsqueda por título ambigua: {[d for _, _, d in scored[:3]]}")
        res.evidence.append(f"búsqueda por título: {top[2]} (puntuación {top[0]:.2f}, margen {gap:.2f})")
        return prefer, top[1]

    # ------------------------------------------------------------------ validación
    def validate_ids(self, entry: AnimeEntry, media_type: MediaType, tmdb_id: int, ext: ExternalIds, check_year: bool) -> ValidationResult:
        v = ValidationResult(performed=True)
        assert self.tmdb is not None
        try:
            d = self.tmdb.details(media_type, tmdb_id)
        except HttpError as err:
            v.performed = False
            v.checks["error"] = str(err)[:200]
            return v
        if d is None:
            v.ok = False
            v.checks["exists"] = "no (404)"
            v.confidence_delta = -1.0
            return v
        v.checks["exists"] = "sí"
        v.tmdb_title = d.get("name")
        date = d.get("date") or ""
        v.tmdb_year = int(date[:4]) if date[:4].isdigit() else None
        delta = 0.0
        hard_fail = False
        if check_year and entry.start_date.year and v.tmdb_year:
            diff = abs(entry.start_date.year - v.tmdb_year)
            if diff <= 1:
                v.checks["año"] = f"coincide ({v.tmdb_year})"
                delta += 0.02
            else:
                v.checks["año"] = f"NO coincide (anime {entry.start_date.year}, TMDB {v.tmdb_year})"
                delta -= 0.2
                hard_fail = True
        else:
            v.checks["año"] = "no comprobado"
        tmdb_titles = [t for t in [d.get("name"), d.get("original_name"), *d.get("alternative_titles", [])] if t]
        sim, a, b = best_similarity(entry.all_titles(), tmdb_titles)
        if sim >= 0.8:
            v.checks["título"] = f"coincide ({sim:.2f}: {a!r} ~ {b!r})"
            delta += 0.01
        elif sim < 0.45:
            v.checks["título"] = f"bajo ({sim:.2f})"
            delta -= 0.05
        else:
            v.checks["título"] = f"parcial ({sim:.2f})"
        if media_type == "tv" and ext.tvdb_show and d.get("tvdb_id"):
            if d["tvdb_id"] in ext.tvdb_show:
                v.checks["tvdb"] = f"coincide ({d['tvdb_id']})"
                delta += 0.02
            else:
                v.checks["tvdb"] = f"distinto (TMDB {d['tvdb_id']} vs mappings {ext.tvdb_show})"
                delta -= 0.1
        if ext.imdb and d.get("imdb_id"):
            v.checks["imdb"] = "coincide" if d["imdb_id"] in ext.imdb else f"distinto ({d['imdb_id']})"
            delta += 0.01 if d["imdb_id"] in ext.imdb else 0.0
        anim = ANIMATION_GENRE in (d.get("genres") or []) or d.get("original_language") in EAST_ASIAN_LANGS
        v.checks["animación"] = "sí" if anim else "no"
        if not anim:
            delta -= 0.1
        v.confidence_delta = round(delta, 3)
        v.ok = not hard_fail and delta > -0.1
        return v

    def _validate(self, entry: AnimeEntry, res: EntryResolution, check_year: bool) -> None:
        if res.source == "override" or not (self.tmdb and self.config.verify_tmdb):
            if not self.tmdb and self.config.verify_tmdb:
                res.evidence.append("validación TMDB omitida (sin TMDB_API_KEY): confianza máxima HIGH_CONFIDENCE")
            return
        assert res.media_type and res.tmdb_id
        v = self.validate_ids(entry, res.media_type, res.tmdb_id, res.external, check_year)
        res.validation = v
        if v.performed and v.ok is False and v.checks.get("exists", "").startswith("no"):
            res.status = MappingStatus.UNMAPPED
            res.evidence.append(f"{res.media_type}:{res.tmdb_id} no existe en TMDB")
            res.media_type = res.tmdb_id = None
            return
        if v.performed:
            res.confidence = max(0.0, min(1.0, res.confidence + v.confidence_delta))

    def _finalize(self, res: EntryResolution) -> None:
        if res.tmdb_id is None:
            return
        if res.status in (MappingStatus.CONFLICT, MappingStatus.NEEDS_REVIEW):
            return
        validated = res.validation.performed and res.validation.ok
        if res.validation.performed and res.validation.ok is False:
            res.status = MappingStatus.NEEDS_REVIEW
            res.evidence.append(f"la validación TMDB no es concluyente: {res.validation.checks}")
        elif res.confidence >= CONFIRMED_THRESHOLD and validated:
            res.status = MappingStatus.CONFIRMED
        elif res.confidence >= self.config.minimum_confidence:
            res.status = MappingStatus.HIGH_CONFIDENCE
        else:
            res.status = MappingStatus.NEEDS_REVIEW
            res.evidence.append(f"confianza {res.confidence:.2f} < mínimo {self.config.minimum_confidence:.2f}")

    def _fill_external(self, res: EntryResolution) -> None:
        tvdb = res.external.tvdb_show
        vt = None
        if self.tmdb and res.media_type and res.tmdb_id:
            try:
                d = self.tmdb.details(res.media_type, res.tmdb_id)
            except HttpError:
                d = None
            if d:
                vt = d.get("tvdb_id")
                res.imdb_id = res.imdb_id or d.get("imdb_id")
        res.tvdb_id = vt if vt else (tvdb[0] if tvdb and res.media_type == "tv" else None)
        res.imdb_id = res.imdb_id or (res.external.imdb[0] if res.external.imdb else None)

    # ------------------------------------------------------------------ salida
    def to_resolved(self, entry: AnimeEntry, res: EntryResolution, *, members: list[str] | None = None,
                    grouping: list[str] | None = None) -> ResolvedTitle:
        return ResolvedTitle(
            title=entry.title,
            canonical_uid=entry.uid,
            canonical_anilist_id=entry.anilist_id,
            mal_id=entry.mal_id,
            media_type=res.media_type,
            tmdb_id=res.tmdb_id,
            tvdb_id=res.tvdb_id,
            imdb_id=res.imdb_id,
            canonical_year=entry.start_date.year,
            canonical_format=entry.format,
            mapping_source=res.source,
            mapping_status=res.status,
            confidence=round(res.confidence, 3),
            members=members or [entry.uid],
            grouping=grouping or [],
            evidence=res.evidence,
            conflicts=res.conflicts,
            validation=res.validation,
            dataset_versions=self.versions,
        )

    def persist(self, rt: ResolvedTitle, res: EntryResolution) -> None:
        self.db.conn.execute(
            """INSERT INTO mappings(canonical_uid, anilist_id, mal_id, anidb_id, media_type, tmdb_id, tvdb_id, imdb_id,
               source, status, confidence, evidence, dataset_versions, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(canonical_uid) DO UPDATE SET anilist_id=excluded.anilist_id, mal_id=excluded.mal_id,
               anidb_id=excluded.anidb_id, media_type=excluded.media_type, tmdb_id=excluded.tmdb_id,
               tvdb_id=excluded.tvdb_id, imdb_id=excluded.imdb_id, source=excluded.source, status=excluded.status,
               confidence=excluded.confidence, evidence=excluded.evidence, dataset_versions=excluded.dataset_versions,
               updated_at=excluded.updated_at""",
            (
                rt.canonical_uid, rt.canonical_anilist_id, rt.mal_id, res.external.anidb[0] if res.external.anidb else None,
                rt.media_type, rt.tmdb_id, rt.tvdb_id, rt.imdb_id, rt.mapping_source, rt.mapping_status.value,
                rt.confidence, json.dumps(rt.evidence + rt.conflicts, ensure_ascii=False), json.dumps(rt.dataset_versions),
                time.time(),
            ),
        )


def describe_status(status: MappingStatus) -> Literal["ok", "warn", "bad"]:
    if status in (MappingStatus.CONFIRMED, MappingStatus.HIGH_CONFIDENCE):
        return "ok"
    if status == MappingStatus.NEEDS_REVIEW:
        return "warn"
    return "bad"
