"""AnimeFilterEngine: evaluación local de filtros (AND/OR/NOT) con motivos de exclusión auditables.

Los filtros se dividen en:
- Temporales (años, décadas, rangos, fechas, temporadas, estrenos futuros, fechas desconocidas):
  se aplican según el `temporal_mode` sobre la entrada adecuada (original, cualquier temporada o la propia).
- Metadatos (formato, puntuación, géneros, tags, estudios, estado, etc. y la `expression`):
  se aplican sobre la entrada canónica, sobre cualquier miembro o sobre la propia entrada (`metadata_scope`).

Todo lo que AniList no permite filtrar en el servidor se filtra aquí, tras obtener los metadatos.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

from ..config import (
    AndExpr,
    FilterBlock,
    FilterExpr,
    Filters,
    IncludeExclude,
    Mode,
    NotExpr,
    OrExpr,
    RangeFilter,
    ScoreFilter,
)
from ..models import AnimeEntry
from ..storage.database import Database
from . import relations

MONTH_SEASON = {12: "WINTER", 1: "WINTER", 2: "WINTER", 3: "SPRING", 4: "SPRING", 5: "SPRING",
                6: "SUMMER", 7: "SUMMER", 8: "SUMMER", 9: "FALL", 10: "FALL", 11: "FALL"}


@dataclass
class Verdict:
    ok: bool
    reasons: list[str] = field(default_factory=list)

    def __bool__(self) -> bool:
        return self.ok


def _cf(values: list[str]) -> set[str]:
    return {v.casefold().strip() for v in values}


def entry_season(e: AnimeEntry) -> str | None:
    """Temporada del proveedor; si falta, se deriva del mes de estreno (convención de AniList)."""
    if e.season:
        return e.season
    if e.start_date.month:
        return MONTH_SEASON[e.start_date.month]
    return None


class AnimeFilterEngine:
    def __init__(self, filters: Filters, *, db: Database | None = None, today: date | None = None):
        self.f = filters
        self.db = db
        self.today = today or date.today()
        self.known: dict[str, AnimeEntry] = {}

    # ------------------------------------------------------------------ temporal
    def temporal(self, e: AnimeEntry) -> Verdict:
        f = self.f
        sd = e.start_date
        if not f.include_future:
            earliest = sd.earliest()
            if e.status == "NOT_YET_RELEASED" or (earliest and earliest > self.today):
                return Verdict(False, [f"estreno futuro ({sd}, {e.status}); include_future=false"])
        if not f.has_temporal():
            return Verdict(True)
        if not sd.known:
            if f.unknown_dates == "include":
                return Verdict(True, ["fecha desconocida incluida por política unknown_dates=include"])
            return Verdict(False, ["fecha de estreno desconocida (unknown_dates=exclude)"])
        y = sd.year
        intervals = f.year_intervals()
        if intervals and not any((a is None or y >= a) and (b is None or y <= b) for a, b in intervals):
            return Verdict(False, [f"año {y} fuera de {self._fmt_intervals(intervals)}"])
        if y in f.exclude_years:
            return Verdict(False, [f"año {y} excluido"])
        if f.date_from or f.date_to:
            lo, hi = sd.earliest(), sd.latest()
            assert lo and hi
            if f.partial_dates == "strict" or sd.complete:
                ok = (not f.date_from or lo >= f.date_from) and (not f.date_to or hi <= f.date_to)
            else:
                ok = (not f.date_from or hi >= f.date_from) and (not f.date_to or lo <= f.date_to)
            if not ok:
                return Verdict(False, [f"fecha {sd} fuera de [{f.date_from or '…'}, {f.date_to or '…'}] (política {f.partial_dates})"])
        if f.seasons:
            s = entry_season(e)
            if s not in f.seasons:
                return Verdict(False, [f"temporada {s or 'desconocida'} no está en {f.seasons}"])
        return Verdict(True)

    @staticmethod
    def _fmt_intervals(intervals: list[tuple[int | None, int | None]]) -> str:
        return ", ".join(f"{a or '…'}-{b or '…'}" for a, b in intervals)

    # ------------------------------------------------------------------ metadatos
    def metadata(self, e: AnimeEntry) -> Verdict:
        top = self._block(self.f, e, top_level=True)
        if not top:
            return top
        if self.f.expression is not None:
            v = self._expr(self.f.expression, e)
            if not v:
                return Verdict(False, [f"expresión: {'; '.join(v.reasons) or 'no se cumple'}"])
        return Verdict(True)

    def _expr(self, expr: FilterExpr, e: AnimeEntry) -> Verdict:
        if isinstance(expr, AndExpr):
            for sub in expr.and_:
                v = self._expr(sub, e)
                if not v:
                    return Verdict(False, [f"AND: {'; '.join(v.reasons)}"])
            return Verdict(True)
        if isinstance(expr, OrExpr):
            reasons = []
            for sub in expr.or_:
                v = self._expr(sub, e)
                if v:
                    return Verdict(True)
                reasons += v.reasons
            return Verdict(False, [f"OR: ninguna rama se cumple ({' | '.join(reasons)})"])
        if isinstance(expr, NotExpr):
            v = self._expr(expr.not_, e)
            return Verdict(not v.ok, [] if not v.ok else ["NOT: la condición negada se cumple"])
        return self._block(expr, e, top_level=False)

    def _block(self, b: FilterBlock, e: AnimeEntry, *, top_level: bool) -> Verdict:
        fail: list[str] = []
        if b.formats is not None and (e.format or "?") not in b.formats:
            fail.append(f"formato {e.format} no está en {b.formats}")
        include_adult = b.include_adult if b.include_adult is not None else (False if top_level else None)
        if include_adult is False and e.is_adult:
            fail.append("contenido adulto excluido")
        if b.score and b.score.active:
            r = self._score(b.score, e)
            if r:
                fail.append(r)
        if b.genres and b.genres.active:
            r = self._include_exclude("géneros", b.genres, e.genres)
            if r:
                fail.append(r)
        if b.tags and b.tags.active:
            r = self._tags(b, e)
            if r:
                fail.append(r)
        if b.studios and b.studios.active:
            names = [
                s.name for s in e.studios
                if (not b.studios.main_only or s.is_main) and (not b.studios.animation_studios_only or s.is_animation_studio)
            ]
            r = self._include_exclude("estudios", b.studios, names)
            if r:
                fail.append(r)
        for label, vs, value in (("estado", b.status, e.status), ("país", b.country, e.country), ("fuente", b.source, e.source)):
            if vs is not None and vs.active:
                v = (value or "").upper()
                if vs.include and v not in vs.include:
                    fail.append(f"{label} {value} no está en {vs.include}")
                if v in vs.exclude:
                    fail.append(f"{label} {value} excluido")
        for label, rng, value in (
            ("popularidad", b.popularity, e.popularity),
            ("favoritos", b.favourites, e.favourites),
            ("episodios", b.episodes, e.episodes),
            ("duración", b.duration, e.duration),
        ):
            if rng is not None and rng.active:
                r = self._range(label, rng, value)
                if r:
                    fail.append(r)
        # En el nivel superior, start_year/end_year son criterios TEMPORALES (dependen del modo temporal);
        # solo dentro de una expresión se evalúan contra la propia entrada.
        y = e.start_date.year
        if not top_level and b.start_year is not None and (y is None or y < b.start_year):
            fail.append(f"año {y} < {b.start_year}")
        if not top_level and b.end_year is not None and (y is None or y > b.end_year):
            fail.append(f"año {y} > {b.end_year}")
        if b.finished_only and e.status != "FINISHED":
            fail.append(f"no finalizado ({e.status})")
        if b.airing_only and e.status != "RELEASING":
            fail.append(f"no está en emisión ({e.status})")
        if b.upcoming_only and e.status != "NOT_YET_RELEASED":
            fail.append(f"no es un próximo estreno ({e.status})")
        if b.exclude_sequels and relations.is_sequel(e):
            fail.append("es una secuela (exclude_sequels)")
        if b.exclude_spinoffs and relations.is_spinoff(e):
            fail.append("es un spin-off (exclude_spinoffs)")
        if b.exclude_side_stories and relations.is_side_story(e):
            fail.append("es una historia paralela (exclude_side_stories)")
        if b.exclude_remakes and relations.is_remake(e):
            fail.append("es un remake (exclude_remakes)")
        if b.exclude_compilations and relations.is_compilation(e, self.db, self.known):
            fail.append("es un recopilatorio (exclude_compilations)")
        if b.exclude_specials and e.format == "SPECIAL":
            fail.append("es un especial (exclude_specials)")
        return Verdict(not fail, fail)

    # ------------------------------------------------------------------ auxiliares
    @staticmethod
    def score_value(s: ScoreFilter, e: AnimeEntry) -> float | None:
        """Puntuación en la escala del filtro (0-100 AniList; 0-10 MAL, o 0-100 si normalize)."""
        if s.provider == "anilist":
            return e.average_score if s.field == "averageScore" else e.mean_score
        if e.mal_score is None:
            return None
        return e.mal_score * 10 if s.normalize else e.mal_score

    def _score(self, s: ScoreFilter, e: AnimeEntry) -> str | None:
        v = self.score_value(s, e)
        label = f"{s.provider}.{s.field}"
        if v is None:
            return None if s.missing == "include" else f"sin puntuación {label}"
        if s.min is not None and v < s.min:
            return f"{label}={v} < {s.min}"
        if s.max is not None and v > s.max:
            return f"{label}={v} > {s.max}"
        if s.min_votes is not None and (e.mal_scored_by or 0) < s.min_votes:
            return f"votos MAL {e.mal_scored_by} < {s.min_votes}"
        return None

    @staticmethod
    def _include_exclude(label: str, f: IncludeExclude, values: list[str]) -> str | None:
        have = _cf(values)
        inc, exc = _cf(f.include), _cf(f.exclude)
        if inc:
            ok = inc <= have if f.mode == Mode.AND else bool(inc & have)
            if not ok:
                return f"{label}: requiere {'todos' if f.mode == Mode.AND else 'alguno'} de {sorted(f.include)}"
        bad = exc & have
        if bad:
            return f"{label}: contiene excluido(s) {sorted(bad)}"
        return None

    @staticmethod
    def _tags(b: FilterBlock, e: AnimeEntry) -> str | None:
        t = b.tags
        assert t is not None
        usable = [x for x in e.tags if t.include_spoilers or not x.is_spoiler]
        # rank None (p. ej. temas de MAL) no tiene relevancia: se considera coincidencia plena.
        matched = {x.name.casefold() for x in usable if x.rank is None or x.rank >= t.min_rank}
        inc = _cf(t.include)
        if inc:
            ok = inc <= matched if t.mode == Mode.AND else bool(inc & matched)
            if not ok:
                return f"tags: requiere {'todos' if t.mode == Mode.AND else 'alguno'} de {sorted(t.include)} con relevancia ≥ {t.min_rank}%"
        exc = _cf(t.exclude)
        bad = {x.name for x in usable if x.name.casefold() in exc and (x.rank is None or x.rank >= t.exclude_min_rank)}
        if bad:
            return f"tags: contiene excluido(s) {sorted(bad)}"
        cats_inc = _cf(t.categories_include)
        if cats_inc and not any((x.category or "").casefold() in cats_inc and (x.rank is None or x.rank >= t.min_rank) for x in usable):
            return f"tags: ninguna etiqueta de las categorías {t.categories_include}"
        cats_exc = _cf(t.categories_exclude)
        badc = {x.category for x in usable if (x.category or "").casefold() in cats_exc and (x.rank is None or x.rank >= t.exclude_min_rank)}
        if badc:
            return f"tags: contiene categorías excluidas {sorted(c for c in badc if c)}"
        return None

    @staticmethod
    def _range(label: str, r: RangeFilter, value: float | None) -> str | None:
        if value is None:
            return f"{label} desconocido"
        if r.min is not None and value < r.min:
            return f"{label} {value} < {r.min}"
        if r.max is not None and value > r.max:
            return f"{label} {value} > {r.max}"
        return None
