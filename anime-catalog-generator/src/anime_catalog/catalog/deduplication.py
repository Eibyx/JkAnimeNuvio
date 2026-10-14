"""DeduplicationEngine: una entrada por identidad final ("tv"|"movie", tmdb_id).

Detecta y documenta:
1. AniList IDs repetidos y 2. MAL IDs repetidos (p. ej. al combinar proveedores).
3. Temporadas de una misma serie (ya agrupadas por el CanonicalAnimeResolver; se reportan aquí).
4-5. TMDB TV/Movie IDs repetidos entre grupos canónicos distintos.
6. Duplicados entre fuentes (AniList y MAL describiendo la misma obra).
7-8. Títulos ya presentes en MDBList o procesados en ejecuciones anteriores (lo calcula el plan de sincronización).

Nunca se usa el título como clave.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..models import ADDABLE_STATUSES, MappingStatus, ResolvedTitle

STATUS_RANK = {
    MappingStatus.CONFIRMED: 0,
    MappingStatus.HIGH_CONFIDENCE: 1,
    MappingStatus.NEEDS_REVIEW: 2,
    MappingStatus.CONFLICT: 3,
    MappingStatus.UNMAPPED: 4,
    MappingStatus.EXCLUDED: 5,
}
FORMAT_RANK = {"TV": 0, "ONA": 1, "TV_SHORT": 2, "MOVIE": 0}


@dataclass
class DuplicateRecord:
    kind: str  # anilist_id | mal_id | tmdb | season_group
    key: str
    kept: str
    dropped: list[str]
    reason: str


@dataclass
class DedupResult:
    unique: list[ResolvedTitle] = field(default_factory=list)
    duplicates: list[DuplicateRecord] = field(default_factory=list)


class DeduplicationEngine:
    def __init__(self, by_tmdb: bool = True, by_canonical: bool = True):
        self.by_tmdb = by_tmdb
        self.by_canonical = by_canonical

    @staticmethod
    def _better(a: ResolvedTitle) -> tuple:
        return (
            STATUS_RANK.get(a.mapping_status, 9),
            a.canonical_year or 9999,
            FORMAT_RANK.get(a.canonical_format or "", 5),
            -a.confidence,
            a.canonical_uid,
        )

    def run(self, titles: list[ResolvedTitle]) -> DedupResult:
        out = DedupResult()
        # Temporadas agrupadas (información de auditoría).
        for t in titles:
            if len(t.members) > 1:
                out.duplicates.append(
                    DuplicateRecord("season_group", t.canonical_uid, t.canonical_uid,
                                    [m for m in t.members if m != t.canonical_uid],
                                    "temporadas/partes del mismo programa agrupadas en la entrada canónica")
                )
        # 1/6. Mismo grupo canónico o mismo ID de anime repetido.
        pool: list[ResolvedTitle] = []
        if self.by_canonical:
            seen_uid: dict[str, ResolvedTitle] = {}
            seen_member: dict[str, str] = {}
            for t in sorted(titles, key=self._better):
                if t.canonical_uid in seen_uid:
                    out.duplicates.append(DuplicateRecord("anilist_id", t.canonical_uid, t.canonical_uid, [t.canonical_uid], "entrada canónica repetida"))
                    continue
                overlap = [m for m in t.members if m in seen_member]
                if overlap:
                    out.duplicates.append(DuplicateRecord("anilist_id", overlap[0], seen_member[overlap[0]], [t.canonical_uid],
                                                          "comparte temporadas con otra entrada canónica"))
                    continue
                seen_uid[t.canonical_uid] = t
                for m in t.members:
                    seen_member[m] = t.canonical_uid
                pool.append(t)
        else:
            pool = list(titles)
        # 2/6. MAL ID repetido (AniList y MAL describen la misma obra).
        by_mal: dict[int, ResolvedTitle] = {}
        stage: list[ResolvedTitle] = []
        for t in sorted(pool, key=self._better):
            if t.mal_id and t.mal_id in by_mal and by_mal[t.mal_id].canonical_uid != t.canonical_uid:
                out.duplicates.append(DuplicateRecord("mal_id", str(t.mal_id), by_mal[t.mal_id].canonical_uid, [t.canonical_uid],
                                                      "mismo MyAnimeList ID"))
                continue
            if t.mal_id:
                by_mal[t.mal_id] = t
            stage.append(t)
        # 4/5. Mismo TMDB ID.
        if self.by_tmdb:
            by_identity: dict[tuple[str, int], ResolvedTitle] = {}
            for t in sorted(stage, key=self._better):
                ident = t.identity
                if ident is None or t.mapping_status not in ADDABLE_STATUSES:
                    out.unique.append(t)
                    continue
                if ident in by_identity:
                    kept = by_identity[ident]
                    out.duplicates.append(DuplicateRecord("tmdb", f"{ident[0]}:{ident[1]}", kept.canonical_uid, [t.canonical_uid],
                                                          f"mismo TMDB {ident[0]} ID que {kept.title}"))
                    kept.grouping.append(f"{t.canonical_uid} ({t.title}) comparte TMDB {ident[0]}:{ident[1]}")
                    continue
                by_identity[ident] = t
                out.unique.append(t)
        else:
            out.unique = stage
        return out
