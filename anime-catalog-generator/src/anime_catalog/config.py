"""Configuración: variables de entorno y esquema YAML estricto de catálogos."""

from __future__ import annotations

import os
import re
from datetime import date
from enum import StrEnum
from pathlib import Path
from typing import Any, Literal, Union

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from .models import FORMATS, SEASONS, STATUSES


class ConfigError(ValueError):
    """Error de configuración legible por el usuario."""


# --------------------------------------------------------------------------- entorno


def load_dotenv(path: Path) -> None:
    """Carga un .env sencillo (CLAVE=valor) sin sobrescribir variables ya definidas."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "on", "si", "sí"}


class Settings(BaseModel):
    """Ajustes de ejecución tomados del entorno. Las claves nunca se imprimen."""

    model_config = ConfigDict(frozen=True)

    mdblist_api_key: str | None = Field(default=None, repr=False)
    tmdb_api_key: str | None = Field(default=None, repr=False)
    tmdb_read_token: str | None = Field(default=None, repr=False)
    tvdb_api_key: str | None = Field(default=None, repr=False)
    tvdb_pin: str | None = Field(default=None, repr=False)
    anilist_api_url: str = "https://graphql.anilist.co"
    jikan_api_url: str = "https://api.jikan.moe/v4"
    tmdb_api_url: str = "https://api.themoviedb.org/3"
    mdblist_api_url: str = "https://api.mdblist.com"
    database_path: Path = Path("data/anime_catalog.db")
    datasets_dir: Path = Path("data/datasets")
    reports_dir: Path = Path("reports")
    overrides_path: Path = Path("overrides.yaml")
    log_level: str = "INFO"
    default_dry_run: bool = True
    http_timeout: float = 60.0

    @classmethod
    def from_env(cls, env_file: Path | None = Path(".env")) -> Settings:
        if env_file is not None:
            load_dotenv(env_file)
        e = os.environ.get

        def opt(name: str) -> str | None:
            v = e(name)
            return v.strip() if v and v.strip() else None

        db = Path(e("DATABASE_PATH") or "data/anime_catalog.db")
        return cls(
            mdblist_api_key=opt("MDBLIST_API_KEY"),
            tmdb_api_key=opt("TMDB_API_KEY"),
            tmdb_read_token=opt("TMDB_READ_ACCESS_TOKEN") or opt("TMDB_API_READ_TOKEN"),
            tvdb_api_key=opt("TVDB_API_KEY"),
            tvdb_pin=opt("TVDB_SUBSCRIBER_PIN"),
            anilist_api_url=e("ANILIST_API_URL") or "https://graphql.anilist.co",
            jikan_api_url=(e("JIKAN_API_URL") or "https://api.jikan.moe/v4").rstrip("/"),
            tmdb_api_url=(e("TMDB_API_URL") or "https://api.themoviedb.org/3").rstrip("/"),
            mdblist_api_url=(e("MDBLIST_API_URL") or "https://api.mdblist.com").rstrip("/"),
            database_path=db,
            datasets_dir=Path(e("DATASETS_DIR") or db.parent / "datasets"),
            reports_dir=Path(e("REPORTS_DIR") or "reports"),
            overrides_path=Path(e("OVERRIDES_PATH") or "overrides.yaml"),
            log_level=(e("LOG_LEVEL") or "INFO").upper(),
            default_dry_run=_env_bool("DEFAULT_DRY_RUN", True),
            http_timeout=float(e("HTTP_TIMEOUT") or 60),
        )

    @property
    def has_tmdb(self) -> bool:
        return bool(self.tmdb_api_key or self.tmdb_read_token)

    def secrets(self) -> list[str]:
        return [s for s in (self.mdblist_api_key, self.tmdb_api_key, self.tmdb_read_token, self.tvdb_api_key, self.tvdb_pin) if s]


# --------------------------------------------------------------------------- esquema YAML


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class Mode(StrEnum):
    AND = "AND"
    OR = "OR"


def _upper_list(v: Any) -> Any:
    if v is None:
        return []
    if isinstance(v, str):
        v = [v]
    return [str(x).strip().upper() for x in v]


class TemporalMode(StrEnum):
    ORIGINAL_RELEASE_YEAR = "original_release_year"
    ANY_SEASON_RELEASE_YEAR = "any_season_release_year"
    ENTRY_RELEASE_YEAR = "entry_release_year"


class MetadataScope(StrEnum):
    CANONICAL = "canonical"  # se evalúa la entrada canónica (serie original)
    ANY_MEMBER = "any_member"  # basta con que una temporada cumpla
    ENTRY = "entry"  # la propia entrada encontrada (modo entry_release_year)


class ScoreFilter(Strict):
    provider: Literal["anilist", "myanimelist"] = "anilist"
    field: Literal["averageScore", "meanScore", "score"] = "averageScore"
    min: float | None = None
    max: float | None = None
    normalize: bool = False  # si True, min/max están en escala 0-100 para cualquier proveedor
    min_votes: int | None = None  # solo MyAnimeList (scored_by)
    missing: Literal["exclude", "include"] = "exclude"

    @model_validator(mode="after")
    def _check(self) -> ScoreFilter:
        if self.provider == "anilist" and self.field == "score":
            raise ValueError("score.field 'score' solo existe en MyAnimeList; usa averageScore o meanScore")
        if self.provider == "myanimelist" and self.field != "score":
            self.field = "score"
        if self.provider == "anilist" and self.min_votes is not None:
            raise ValueError("score.min_votes solo está disponible con provider: myanimelist (scored_by)")
        scale = 100 if (self.provider == "anilist" or self.normalize) else 10
        for name in ("min", "max"):
            v = getattr(self, name)
            if v is not None and not 0 <= v <= scale:
                raise ValueError(f"score.{name}={v} fuera de la escala 0-{scale} de {self.provider}")
        if self.min is not None and self.max is not None and self.min > self.max:
            raise ValueError("score.min no puede ser mayor que score.max")
        return self

    @property
    def active(self) -> bool:
        return self.min is not None or self.max is not None or self.min_votes is not None


class IncludeExclude(Strict):
    include: list[str] = Field(default_factory=list)
    exclude: list[str] = Field(default_factory=list)
    mode: Mode = Mode.OR

    @field_validator("include", "exclude", mode="before")
    @classmethod
    def _listify(cls, v: Any) -> Any:
        if v is None:
            return []
        return [v] if isinstance(v, str) else v

    @field_validator("mode", mode="before")
    @classmethod
    def _mode(cls, v: Any) -> Any:
        return str(v).upper() if v is not None else Mode.OR

    @property
    def active(self) -> bool:
        return bool(self.include or self.exclude)


class GenreFilter(IncludeExclude):
    pass


class TagFilter(IncludeExclude):
    min_rank: int = 0
    exclude_min_rank: int = 0
    categories_include: list[str] = Field(default_factory=list)
    categories_exclude: list[str] = Field(default_factory=list)
    include_spoilers: bool = True

    @property
    def active(self) -> bool:
        return bool(self.include or self.exclude or self.categories_include or self.categories_exclude)


class StudioFilter(IncludeExclude):
    main_only: bool = False
    animation_studios_only: bool = False


class RangeFilter(Strict):
    min: float | None = None
    max: float | None = None

    @property
    def active(self) -> bool:
        return self.min is not None or self.max is not None


class ValueSet(Strict):
    include: list[str] = Field(default_factory=list)
    exclude: list[str] = Field(default_factory=list)

    @field_validator("include", "exclude", mode="before")
    @classmethod
    def _up(cls, v: Any) -> Any:
        return _upper_list(v)

    @property
    def active(self) -> bool:
        return bool(self.include or self.exclude)


class FilterBlock(Strict):
    """Criterios de metadatos. Todos los presentes se combinan con AND."""

    formats: list[str] | None = None
    score: ScoreFilter | None = None
    genres: GenreFilter | None = None
    tags: TagFilter | None = None
    studios: StudioFilter | None = None
    status: ValueSet | None = None
    country: ValueSet | None = None
    source: ValueSet | None = None
    popularity: RangeFilter | None = None
    favourites: RangeFilter | None = None
    episodes: RangeFilter | None = None
    duration: RangeFilter | None = None
    # Fechas dentro de expresiones: se evalúan sobre la entrada evaluada (no sobre el modo temporal).
    start_year: int | None = None
    end_year: int | None = None
    finished_only: bool = False
    airing_only: bool = False
    upcoming_only: bool = False
    include_adult: bool | None = None
    exclude_sequels: bool = False
    exclude_spinoffs: bool = False
    exclude_side_stories: bool = False
    exclude_compilations: bool = False
    exclude_remakes: bool = False
    exclude_specials: bool = False

    @field_validator("formats", mode="before")
    @classmethod
    def _formats(cls, v: Any) -> Any:
        if v is None:
            return None
        out = _upper_list(v)
        bad = [f for f in out if f not in FORMATS]
        if bad:
            raise ValueError(f"formato(s) desconocido(s): {bad}. Válidos: {list(FORMATS)}")
        return out

    @field_validator("status", mode="after")
    @classmethod
    def _status(cls, v: ValueSet | None) -> ValueSet | None:
        if v is not None:
            bad = [s for s in v.include + v.exclude if s not in STATUSES]
            if bad:
                raise ValueError(f"estado(s) desconocido(s): {bad}. Válidos: {list(STATUSES)}")
        return v


class AndExpr(Strict):
    and_: list[FilterExpr] = Field(alias="and")


class OrExpr(Strict):
    or_: list[FilterExpr] = Field(alias="or")


class NotExpr(Strict):
    not_: FilterExpr = Field(alias="not")


FilterExpr = Union[AndExpr, OrExpr, NotExpr, FilterBlock]
AndExpr.model_rebuild()
OrExpr.model_rebuild()
NotExpr.model_rebuild()

_YEAR_RANGE = re.compile(r"^\s*(\d{4})\s*-\s*(\d{4})\s*$")
_DECADE = re.compile(r"^\s*(\d{3})0s\s*$")


class Filters(FilterBlock):
    """Filtros de primer nivel: criterios temporales + metadatos + expresión opcional."""

    years: list[int] = Field(default_factory=list)
    exclude_years: list[int] = Field(default_factory=list)
    decades: list[int] = Field(default_factory=list)
    year_ranges: list[str] = Field(default_factory=list)
    date_from: date | None = None
    date_to: date | None = None
    seasons: list[str] | dict[str, Any] | None = None
    temporal_mode: TemporalMode = TemporalMode.ORIGINAL_RELEASE_YEAR
    metadata_scope: MetadataScope | None = None
    unknown_dates: Literal["exclude", "include"] = "exclude"
    partial_dates: Literal["strict", "overlap"] = "strict"
    include_future: bool = False
    expression: FilterExpr | None = None
    sort: Literal["start_date", "score", "popularity", "favourites", "title"] = "start_date"
    order: Literal["asc", "desc"] = "asc"
    limit: int | None = None

    @field_validator("seasons", mode="before")
    @classmethod
    def _seasons(cls, v: Any) -> Any:
        if isinstance(v, dict):  # admite {include: [...]}
            v = v.get("include") or []
        out = _upper_list(v)
        bad = [s for s in out if s not in SEASONS]
        if bad:
            raise ValueError(f"temporada(s) desconocida(s): {bad}. Válidas: {list(SEASONS)}")
        return out

    @field_validator("decades", mode="before")
    @classmethod
    def _decades(cls, v: Any) -> Any:
        out = []
        for d in v or []:
            m = _DECADE.match(str(d))
            n = int(m.group(1)) * 10 if m else int(d)
            if n % 10:
                raise ValueError(f"década inválida: {d} (usa 1990, 2000, ... o '1990s')")
            out.append(n)
        return out

    @field_validator("year_ranges", mode="before")
    @classmethod
    def _ranges(cls, v: Any) -> Any:
        out = []
        for r in v or []:
            m = _YEAR_RANGE.match(str(r))
            if not m or int(m.group(1)) > int(m.group(2)):
                raise ValueError(f"rango de años inválido: {r!r} (formato 'AAAA-AAAA')")
            out.append(f"{m.group(1)}-{m.group(2)}")
        return out

    @model_validator(mode="after")
    def _coherence(self) -> Filters:
        if self.start_year and self.end_year and self.start_year > self.end_year:
            raise ValueError(f"start_year ({self.start_year}) es mayor que end_year ({self.end_year})")
        if self.date_from and self.date_to and self.date_from > self.date_to:
            raise ValueError("date_from es posterior a date_to")
        if self.finished_only and (self.airing_only or self.upcoming_only):
            raise ValueError("finished_only es incompatible con airing_only/upcoming_only")
        if self.airing_only and self.upcoming_only:
            raise ValueError("airing_only es incompatible con upcoming_only")
        if self.upcoming_only and not self.include_future:
            self.include_future = True
        if self.metadata_scope is None:
            self.metadata_scope = (
                MetadataScope.ENTRY
                if self.temporal_mode == TemporalMode.ENTRY_RELEASE_YEAR
                else MetadataScope.CANONICAL
            )
        if self.temporal_mode == TemporalMode.ENTRY_RELEASE_YEAR and self.metadata_scope != MetadataScope.ENTRY:
            raise ValueError("temporal_mode entry_release_year solo admite metadata_scope: entry")
        if self.temporal_mode != TemporalMode.ENTRY_RELEASE_YEAR and self.metadata_scope == MetadataScope.ENTRY:
            raise ValueError("metadata_scope: entry solo es válido con temporal_mode entry_release_year")
        if self.formats is None:
            self.formats = ["TV", "MOVIE"]
        return self

    # ---- utilidades
    def year_intervals(self) -> list[tuple[int | None, int | None]]:
        """Intervalos de años inclusivos (unión). Lista vacía = sin restricción."""
        out: list[tuple[int | None, int | None]] = []
        if self.start_year is not None or self.end_year is not None:
            out.append((self.start_year, self.end_year))
        out += [(y, y) for y in self.years]
        out += [(d, d + 9) for d in self.decades]
        for r in self.year_ranges:
            a, b = r.split("-")
            out.append((int(a), int(b)))
        return out

    def has_temporal(self) -> bool:
        return bool(self.year_intervals() or self.date_from or self.date_to or self.seasons or self.exclude_years)

    def date_bounds(self) -> tuple[date | None, date | None]:
        """Envolvente de fechas para consultas al proveedor (superconjunto)."""
        lo: date | None = None
        hi: date | None = None
        intervals = self.year_intervals()
        if intervals:
            if all(a is not None for a, _ in intervals):
                lo = date(min(a for a, _ in intervals if a is not None), 1, 1)
            if all(b is not None for _, b in intervals):
                hi = date(max(b for _, b in intervals if b is not None), 12, 31)
        if self.date_from:
            lo = max(lo, self.date_from) if lo else self.date_from
        if self.date_to:
            hi = min(hi, self.date_to) if hi else self.date_to
        return lo, hi


class SourceConfig(Strict):
    primary: Literal["anilist", "myanimelist", "hybrid"] = "anilist"
    fallback: Literal["myanimelist", "none"] | None = None
    enrich_mal_scores: bool = False  # en modo híbrido, consultar Jikan para puntuaciones MAL


class CanonicalConfig(Strict):
    enabled: bool = True
    first_only: bool = True
    collapse_seasons: bool = True
    preserve_remakes: bool = True
    preserve_spinoffs: bool = True
    preserve_independent_movies: bool = True
    merge_unmapped_sequels: bool = True  # secuelas sin mapping se agregan al grupo (nunca se publican solas)
    complete_shows_from_mappings: bool = True  # usar índice inverso TMDB->AniList para hallar la temporada 1
    max_prequel_depth: int = 40


class MappingConfig(Strict):
    primary: str = "anibridge"
    fallbacks: list[str] = Field(default_factory=lambda: ["kometa", "fribb", "anime_lists", "tmdb"])
    verify_tmdb: bool = True
    allow_title_search: bool = True
    minimum_confidence: float = 0.90
    ambiguous_policy: Literal["review", "skip"] = "review"
    movie_allow_show_mapping: bool = False

    @field_validator("primary")
    @classmethod
    def _primary(cls, v: str) -> str:
        if v not in {"anibridge", "kometa", "fribb", "anime_lists"}:
            raise ValueError(f"mapping.primary desconocido: {v}")
        return v

    @field_validator("fallbacks")
    @classmethod
    def _fallbacks(cls, v: list[str]) -> list[str]:
        bad = [x for x in v if x not in {"anibridge", "kometa", "fribb", "anime_lists", "tmdb"}]
        if bad:
            raise ValueError(f"mapping.fallbacks desconocido(s): {bad}")
        return v

    @field_validator("minimum_confidence")
    @classmethod
    def _conf(cls, v: float) -> float:
        if not 0 < v <= 1:
            raise ValueError("minimum_confidence debe estar entre 0 y 1")
        return v

    def source_order(self) -> list[str]:
        out = [self.primary] + [s for s in self.fallbacks if s != self.primary]
        return list(dict.fromkeys(out))


class DuplicatesConfig(Strict):
    enabled: bool = True
    dedupe_by_tmdb_id: bool = True
    dedupe_by_canonical_anime: bool = True


class SyncMode(StrEnum):
    CREATE = "create"
    APPEND = "append"
    SYNC = "sync"
    REPLACE = "replace"


class MDBListConfig(Strict):
    mode: SyncMode = SyncMode.APPEND
    create_if_missing: bool = True
    reuse_existing: bool = True  # en modo create, reutilizar la lista si ya existe
    list_id: int | None = None  # fija una lista concreta (evita ambigüedad por nombre)
    private: bool = False
    dry_run: bool = True
    batch_size: int = 100
    preserve_existing: bool = True
    allow_removals: bool = False  # sync: eliminar elementos gestionados que ya no cumplen

    @field_validator("batch_size")
    @classmethod
    def _batch(cls, v: int) -> int:
        if not 1 <= v <= 1000:
            raise ValueError("batch_size debe estar entre 1 y 1000")
        return v


class ReportsConfig(Strict):
    json_: bool = Field(default=True, alias="json")
    csv: bool = True
    html: bool = True
    directory: str | None = None


class CatalogInfo(Strict):
    name: str
    description: str | None = None
    enabled: bool = True  # para la sincronización programada

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("catalog.name no puede estar vacío")
        return v


class CatalogConfig(Strict):
    catalog: CatalogInfo
    source: SourceConfig = Field(default_factory=SourceConfig)
    filters: Filters = Field(default_factory=Filters)
    canonical: CanonicalConfig = Field(default_factory=CanonicalConfig)
    mapping: MappingConfig = Field(default_factory=MappingConfig)
    duplicates: DuplicatesConfig = Field(default_factory=DuplicatesConfig)
    mdblist: MDBListConfig = Field(default_factory=MDBListConfig)
    reports: ReportsConfig = Field(default_factory=ReportsConfig)

    @model_validator(mode="after")
    def _cross(self) -> CatalogConfig:
        f = self.filters
        if f.score and f.score.provider == "myanimelist" and self.source.primary == "anilist" and not self.source.enrich_mal_scores:
            raise ValueError(
                "score.provider=myanimelist con source.primary=anilist requiere source.enrich_mal_scores: true "
                "(o usa source.primary: hybrid/myanimelist)"
            )
        if f.score and f.score.provider == "anilist" and self.source.primary == "myanimelist":
            raise ValueError("score.provider=anilist no está disponible con source.primary=myanimelist")
        if f.temporal_mode != TemporalMode.ENTRY_RELEASE_YEAR and not self.canonical.enabled:
            raise ValueError(
                f"temporal_mode {f.temporal_mode.value} requiere canonical.enabled: true "
                "(usa entry_release_year para trabajar sin resolución canónica)"
            )
        if self.canonical.first_only and not self.canonical.enabled:
            raise ValueError("canonical.first_only requiere canonical.enabled: true")
        if self.source.primary == "hybrid" and self.source.enrich_mal_scores is False and f.score and f.score.provider == "myanimelist":
            self.source.enrich_mal_scores = True
        return self


def format_validation_error(err: ValidationError) -> str:
    lines = []
    for e in err.errors():
        loc = ".".join(str(x) for x in e["loc"] if not str(x).startswith(("function-", "tagged")))
        lines.append(f"  - {loc or '(raíz)'}: {e['msg']}")
    return "Configuración inválida:\n" + "\n".join(lines)


def parse_config(data: dict[str, Any]) -> CatalogConfig:
    try:
        return CatalogConfig.model_validate(data)
    except ValidationError as err:
        raise ConfigError(format_validation_error(err)) from err


def load_config(path: Path) -> CatalogConfig:
    if not path.is_file():
        raise ConfigError(f"No existe el archivo de configuración: {path}")
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as err:
        raise ConfigError(f"YAML inválido en {path}: {err}") from err
    if not isinstance(data, dict):
        raise ConfigError(f"{path}: el documento YAML debe ser un objeto")
    return parse_config(data)
