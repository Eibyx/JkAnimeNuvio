"""Modelos de datos normalizados compartidos por todos los módulos."""

from __future__ import annotations

import calendar
from datetime import date
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field

MediaType = Literal["tv", "movie"]

# Formatos de AniList (MediaFormat). Jikan se normaliza a estos mismos valores.
FORMATS = ("TV", "TV_SHORT", "MOVIE", "SPECIAL", "OVA", "ONA", "MUSIC")
# Formatos que representan un programa por episodios y pueden formar parte de una serie de TMDB.
SERIES_FORMATS = frozenset({"TV", "TV_SHORT", "ONA", "OVA", "SPECIAL"})
# Formatos que pueden ser la entrada "original" de un programa televisivo.
BROADCAST_FORMATS = frozenset({"TV", "TV_SHORT", "ONA"})
SEASONS = ("WINTER", "SPRING", "SUMMER", "FALL")
STATUSES = ("FINISHED", "RELEASING", "NOT_YET_RELEASED", "CANCELLED", "HIATUS")


class MappingStatus(StrEnum):
    CONFIRMED = "confirmed"
    HIGH_CONFIDENCE = "high_confidence"
    NEEDS_REVIEW = "needs_review"
    UNMAPPED = "unmapped"
    CONFLICT = "conflict"
    EXCLUDED = "excluded"  # excluido manualmente mediante override


ADDABLE_STATUSES = frozenset({MappingStatus.CONFIRMED, MappingStatus.HIGH_CONFIDENCE})


class FuzzyDate(BaseModel):
    """Fecha posiblemente incompleta (AniList usa año/mes/día opcionales)."""

    year: int | None = None
    month: int | None = None
    day: int | None = None

    @property
    def known(self) -> bool:
        return self.year is not None

    @property
    def complete(self) -> bool:
        return None not in (self.year, self.month, self.day)

    def earliest(self) -> date | None:
        if self.year is None:
            return None
        return date(self.year, self.month or 1, self.day or 1)

    def latest(self) -> date | None:
        if self.year is None:
            return None
        month = self.month or 12
        day = self.day or calendar.monthrange(self.year, month)[1]
        return date(self.year, month, day)

    def sort_key(self) -> tuple[int, int, int]:
        return (self.year or 9999, self.month or 13, self.day or 32)

    def to_int(self) -> int | None:
        if self.year is None:
            return None
        return self.year * 10000 + (self.month or 0) * 100 + (self.day or 0)

    @classmethod
    def from_iso(cls, value: str | None) -> FuzzyDate:
        if not value:
            return cls()
        parts = value[:10].split("-")
        try:
            nums = [int(p) for p in parts]
        except ValueError:
            return cls()
        return cls(year=nums[0], month=nums[1] if len(nums) > 1 else None, day=nums[2] if len(nums) > 2 else None)

    def __str__(self) -> str:
        if self.year is None:
            return "?"
        out = f"{self.year:04d}"
        if self.month:
            out += f"-{self.month:02d}"
            if self.day:
                out += f"-{self.day:02d}"
        return out


class Tag(BaseModel):
    name: str
    rank: int | None = None  # relevancia 0-100 (AniList). None si el proveedor no la da.
    category: str | None = None
    is_spoiler: bool = False
    is_adult: bool = False


class Studio(BaseModel):
    name: str
    is_main: bool = False
    is_animation_studio: bool = True


class Relation(BaseModel):
    relation_type: str  # enumeración de AniList (PREQUEL, SEQUEL, PARENT, ...)
    target_uid: str  # "anilist:123" o "mal:123"
    target_type: str = "ANIME"
    target_format: str | None = None
    target_start: FuzzyDate | None = None
    target_title: str | None = None


class AnimeEntry(BaseModel):
    """Registro de anime normalizado, independiente del proveedor."""

    provider: Literal["anilist", "myanimelist"]
    anilist_id: int | None = None
    mal_id: int | None = None
    title_romaji: str | None = None
    title_english: str | None = None
    title_native: str | None = None
    synonyms: list[str] = Field(default_factory=list)
    start_date: FuzzyDate = Field(default_factory=FuzzyDate)
    end_date: FuzzyDate = Field(default_factory=FuzzyDate)
    season: str | None = None
    season_year: int | None = None
    format: str | None = None
    status: str | None = None
    episodes: int | None = None
    duration: int | None = None
    average_score: int | None = None  # AniList 0-100
    mean_score: int | None = None  # AniList 0-100
    popularity: int | None = None
    favourites: int | None = None
    genres: list[str] = Field(default_factory=list)
    tags: list[Tag] = Field(default_factory=list)
    studios: list[Studio] = Field(default_factory=list)
    country: str | None = None
    source: str | None = None
    is_adult: bool = False
    relations: list[Relation] = Field(default_factory=list)
    mal_score: float | None = None  # MyAnimeList 0-10
    mal_scored_by: int | None = None
    mal_members: int | None = None

    @property
    def uid(self) -> str:
        if self.provider == "anilist" and self.anilist_id is not None:
            return f"anilist:{self.anilist_id}"
        return f"mal:{self.mal_id}"

    @property
    def title(self) -> str:
        return self.title_english or self.title_romaji or self.title_native or self.uid

    def all_titles(self) -> list[str]:
        seen: list[str] = []
        for t in [self.title_romaji, self.title_english, self.title_native, *self.synonyms]:
            if t and t not in seen:
                seen.append(t)
        return seen

    def relations_of(self, *types: str) -> list[Relation]:
        return [r for r in self.relations if r.relation_type in types and r.target_type == "ANIME"]


class MappingCandidate(BaseModel):
    """Un posible identificador TMDB para una entrada, con su procedencia."""

    media_type: MediaType
    tmdb_id: int
    season: int | None = None  # temporada TMDB del descriptor (solo para interpretar)
    source: str  # anibridge | kometa | fribb | anime_lists | tmdb_find | title_search | override
    via: str  # cómo se llegó: "anilist:21 -> tmdb_show:37854:s1"
    lineage: frozenset[str] = frozenset()
    reverse: bool = False  # obtenido mediante índice inverso
    weight: float = 1.0  # p. ej. episodios cubiertos


class ExternalIds(BaseModel):
    anidb: list[int] = Field(default_factory=list)
    tvdb_show: list[int] = Field(default_factory=list)
    tvdb_movie: list[int] = Field(default_factory=list)
    imdb: list[str] = Field(default_factory=list)
    anilist: list[int] = Field(default_factory=list)
    mal: list[int] = Field(default_factory=list)


class ValidationResult(BaseModel):
    performed: bool = False
    ok: bool | None = None
    tmdb_title: str | None = None
    tmdb_year: int | None = None
    checks: dict[str, str] = Field(default_factory=dict)
    confidence_delta: float = 0.0


class ResolvedTitle(BaseModel):
    """Resultado normalizado de una serie/película canónica."""

    title: str
    canonical_uid: str
    canonical_anilist_id: int | None = None
    mal_id: int | None = None
    media_type: MediaType | None = None
    tmdb_id: int | None = None
    tvdb_id: int | None = None
    imdb_id: str | None = None
    canonical_year: int | None = None
    canonical_format: str | None = None
    mapping_source: str | None = None
    mapping_status: MappingStatus = MappingStatus.UNMAPPED
    confidence: float = 0.0
    members: list[str] = Field(default_factory=list)
    grouping: list[str] = Field(default_factory=list)  # motivos de agrupación
    evidence: list[str] = Field(default_factory=list)
    conflicts: list[str] = Field(default_factory=list)
    validation: ValidationResult = Field(default_factory=ValidationResult)
    dataset_versions: dict[str, str] = Field(default_factory=dict)

    @property
    def identity(self) -> tuple[str, int] | None:
        if self.media_type and self.tmdb_id:
            return (self.media_type, self.tmdb_id)
        return None

    @property
    def addable(self) -> bool:
        return self.mapping_status in ADDABLE_STATUSES and self.identity is not None
