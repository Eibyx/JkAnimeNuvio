"""Cliente de AniList GraphQL con paginación completa y particionado por fechas.

AniList limita `pageInfo.total` a 5000 resultados por consulta, así que las consultas
amplias se dividen en intervalos de fechas (FuzzyDateInt) hasta que cada partición
queda por debajo del límite. Respeta X-RateLimit-* y Retry-After.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Generator, Iterator
from dataclasses import dataclass, field
from datetime import date
from typing import Any

import httpx

from ..http import HttpClient, HttpError
from ..models import AnimeEntry, FuzzyDate, Relation, Studio, Tag
from ..storage.cache import Cache
from ..storage.repository import AnimeRepository

log = logging.getLogger(__name__)

RESULT_CAP = 5000  # AniList no pagina más allá de este total por consulta
PER_PAGE = 50
MIN_YEAR = 1907  # primeras obras catalogadas en AniList

MEDIA_FIELDS = """
id idMal type
title { romaji english native }
synonyms
startDate { year month day }
endDate { year month day }
season seasonYear format status episodes duration
averageScore meanScore popularity favourites
genres
tags { name rank category isMediaSpoiler isAdult }
studios { edges { isMain node { id name isAnimationStudio } } }
countryOfOrigin source(version: 3) isAdult
relations { edges { relationType(version: 2) node { id idMal type format startDate { year month day } title { romaji english } } } }
"""

PAGE_QUERY = (
    """
query ($page: Int, $perPage: Int, $greater: FuzzyDateInt, $lesser: FuzzyDateInt, $formats: [MediaFormat],
       $isAdult: Boolean, $country: CountryCode, $status: [MediaStatus], $genres: [String], $genresNot: [String],
       $tags: [String], $tagsNot: [String], $minScore: Int, $minPopularity: Int, $season: MediaSeason,
       $seasonYear: Int, $sort: [MediaSort]) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total perPage currentPage lastPage hasNextPage }
    media(type: ANIME, startDate_greater: $greater, startDate_lesser: $lesser, format_in: $formats,
          isAdult: $isAdult, countryOfOrigin: $country, status_in: $status, genre_in: $genres,
          genre_not_in: $genresNot, tag_in: $tags, tag_not_in: $tagsNot, averageScore_greater: $minScore,
          popularity_greater: $minPopularity, season: $season, seasonYear: $seasonYear, sort: $sort) {
      %s
    }
  }
}
"""
    % MEDIA_FIELDS
)

IDS_QUERY = (
    """
query ($ids: [Int], $idMals: [Int], $perPage: Int) {
  Page(page: 1, perPage: $perPage) {
    media(type: ANIME, id_in: $ids, idMal_in: $idMals) { %s }
  }
}
"""
    % MEDIA_FIELDS
)

STUDIO_SEARCH_QUERY = """
query ($search: String) { Page(page: 1, perPage: 10) { studios(search: $search) { id name isAnimationStudio } } }
"""

STUDIO_MEDIA_QUERY = (
    """
query ($id: Int, $page: Int, $perPage: Int) {
  Studio(id: $id) {
    id name
    media(page: $page, perPage: $perPage, sort: START_DATE) {
      pageInfo { total currentPage lastPage hasNextPage }
      nodes { %s }
    }
  }
}
"""
    % MEDIA_FIELDS
)


@dataclass
class ServerFilters:
    """Argumentos que se envían a AniList. Deben ser siempre un SUPERCONJUNTO del filtro local."""

    formats: list[str] | None = None
    is_adult: bool | None = None
    country: str | None = None
    status: list[str] | None = None
    genres: list[str] | None = None
    genres_not: list[str] | None = None
    tags: list[str] | None = None
    tags_not: list[str] | None = None
    min_score: int | None = None
    min_popularity: int | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def variables(self) -> dict[str, Any]:
        v = {
            "formats": self.formats,
            "isAdult": self.is_adult,
            "country": self.country,
            "status": self.status,
            "genres": self.genres,
            "genresNot": self.genres_not,
            "tags": self.tags,
            "tagsNot": self.tags_not,
            "minScore": self.min_score,
            "minPopularity": self.min_popularity,
            **self.extra,
        }
        return {k: x for k, x in v.items() if x not in (None, [])}



def _fuzzy(obj: dict[str, Any] | None) -> FuzzyDate:
    obj = obj or {}
    return FuzzyDate(year=obj.get("year"), month=obj.get("month"), day=obj.get("day"))


def normalize_media(m: dict[str, Any]) -> AnimeEntry:
    title = m.get("title") or {}
    rels: list[Relation] = []
    for edge in (m.get("relations") or {}).get("edges") or []:
        node = edge.get("node") or {}
        if not node.get("id"):
            continue
        t = node.get("title") or {}
        rels.append(
            Relation(
                relation_type=edge.get("relationType") or "OTHER",
                target_uid=f"anilist:{node['id']}",
                target_type=node.get("type") or "ANIME",
                target_format=node.get("format"),
                target_start=_fuzzy(node.get("startDate")),
                target_title=t.get("english") or t.get("romaji"),
            )
        )
    studios = [
        Studio(
            name=(e.get("node") or {}).get("name") or "",
            is_main=bool(e.get("isMain")),
            is_animation_studio=bool((e.get("node") or {}).get("isAnimationStudio", True)),
        )
        for e in (m.get("studios") or {}).get("edges") or []
        if (e.get("node") or {}).get("name")
    ]
    tags = [
        Tag(
            name=t["name"],
            rank=t.get("rank"),
            category=t.get("category"),
            is_spoiler=bool(t.get("isMediaSpoiler")),
            is_adult=bool(t.get("isAdult")),
        )
        for t in m.get("tags") or []
        if t.get("name")
    ]
    return AnimeEntry(
        provider="anilist",
        anilist_id=m["id"],
        mal_id=m.get("idMal"),
        title_romaji=title.get("romaji"),
        title_english=title.get("english"),
        title_native=title.get("native"),
        synonyms=[s for s in m.get("synonyms") or [] if s],
        start_date=_fuzzy(m.get("startDate")),
        end_date=_fuzzy(m.get("endDate")),
        season=m.get("season"),
        season_year=m.get("seasonYear"),
        format=m.get("format"),
        status=m.get("status"),
        episodes=m.get("episodes"),
        duration=m.get("duration"),
        average_score=m.get("averageScore"),
        mean_score=m.get("meanScore"),
        popularity=m.get("popularity"),
        favourites=m.get("favourites"),
        genres=list(m.get("genres") or []),
        tags=tags,
        studios=studios,
        country=m.get("countryOfOrigin"),
        source=m.get("source"),
        is_adult=bool(m.get("isAdult")),
        relations=rels,
    )


class AniListError(HttpError):
    pass


class AniListClient:
    def __init__(
        self,
        url: str,
        repo: AnimeRepository,
        cache: Cache,
        *,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 60.0,
        sleep: Any = None,
    ):
        kwargs: dict[str, Any] = {}
        if sleep is not None:
            kwargs["sleep"] = sleep
        self.http = HttpClient(
            "", timeout=timeout, min_interval=2.1, transport=transport, name="AniList",
            headers={"Content-Type": "application/json"}, **kwargs,
        )
        self.url = url
        self.repo = repo
        self.cache = cache
        self.pages_fetched = 0
        self.partitions: list[str] = []

    def close(self) -> None:
        self.http.close()

    # ------------------------------------------------------------------ bajo nivel
    def graphql(self, query: str, variables: dict[str, Any]) -> dict[str, Any]:
        resp = self.http.request("POST", self.url, json={"query": query, "variables": variables})
        self._adapt_rate(resp)
        try:
            body = resp.json()
        except ValueError as err:
            raise AniListError(f"AniList: respuesta no JSON (HTTP {resp.status_code})", status=resp.status_code) from err
        if resp.status_code != 200 or body.get("errors"):
            msgs = "; ".join(str(e.get("message")) for e in body.get("errors") or []) or resp.text[:200]
            raise AniListError(f"AniList: HTTP {resp.status_code}: {msgs}", status=resp.status_code, body=body)
        return body["data"]

    def _adapt_rate(self, resp: httpx.Response) -> None:
        limit = resp.headers.get("X-RateLimit-Limit")
        remaining = resp.headers.get("X-RateLimit-Remaining")
        if limit and limit.isdigit() and int(limit) > 0:
            # 90/min en condiciones normales, 30/min en modo degradado.
            self.http.limiter.min_interval = 60.0 / int(limit) + 0.05
        if remaining is not None and remaining.isdigit() and int(remaining) <= 1:
            reset = resp.headers.get("X-RateLimit-Reset")
            try:
                import time as _t

                wait = max(1.0, float(reset) - _t.time()) if reset else 60.0
            except ValueError:
                wait = 60.0
            log.info("AniList: límite de solicitudes casi agotado, pausa de %.0fs", wait)
            self.http.limiter.pause_for(min(wait, 65.0))

    # ------------------------------------------------------------------ consultas
    def _page(self, variables: dict[str, Any]) -> dict[str, Any]:
        self.pages_fetched += 1
        return self.graphql(PAGE_QUERY, variables)["Page"]

    def iter_range(
        self,
        lo: date | None,
        hi: date | None,
        server: ServerFilters,
        *,
        season: str | None = None,
        season_year: int | None = None,
    ) -> Iterator[AnimeEntry]:
        """Itera TODAS las entradas con fecha de inicio en [lo, hi] (inclusive), particionando si hace falta."""
        # Se amplía a años completos para incluir fechas incompletas ("2020" = 20200000,
        # "2020-06" = 20200600). El filtro local decide después con la política configurada.
        lo_i = lo.year * 10000 if lo else None
        hi_i = hi.year * 10000 + 1299 if hi else None
        base = {"sort": ["START_DATE", "ID"], **server.variables()}
        if season:
            base["season"] = season
        if season_year:
            base["seasonYear"] = season_year
        seen: set[int] = set()
        if lo_i is None and hi_i is None:
            # Sin fechas: una sola pasada si cabe; si no, por años (más una consulta de próximos
            # estrenos, que pueden no tener fecha y no aparecerían en consultas por fecha).
            done = yield from self._paginate(None, None, base, seen)
            if done:
                return
            lo_i, hi_i = MIN_YEAR * 10000, (date.today().year + 5) * 10000 + 1299
            yield from self._paginate(None, None, {**base, "status": ["NOT_YET_RELEASED"]}, seen)
        # Partición inicial por años naturales; cada año se subdivide solo si alcanza el límite.
        assert lo_i is not None or hi_i is not None
        y0 = (lo_i if lo_i is not None else MIN_YEAR * 10000) // 10000
        y1 = (hi_i if hi_i is not None else (date.today().year + 5) * 10000) // 10000
        for year in range(y0, y1 + 1):
            yield from self._iter_partition(year * 10000, year * 10000 + 1299, base, seen)

    def _iter_partition(self, lo_i: int, hi_i: int, base: dict[str, Any], seen: set[int]) -> Iterator[AnimeEntry]:
        complete = yield from self._paginate(lo_i, hi_i, base, seen)
        if complete:
            return
        if hi_i > lo_i:
            mid = (lo_i + hi_i) // 2
            log.info("AniList: la partición %s..%s alcanza %d resultados; se divide", lo_i, hi_i, RESULT_CAP)
            yield from self._iter_partition(lo_i, mid, base, seen)
            yield from self._iter_partition(mid + 1, hi_i, base, seen)
        else:
            log.warning("AniList: la fecha %s supera %d resultados y no puede dividirse más", lo_i, RESULT_CAP)

    def _paginate(self, lo_i: int | None, hi_i: int | None, base: dict[str, Any], seen: set[int]) -> Generator[AnimeEntry, None, bool]:
        """Recorre todas las páginas de una partición. Devuelve False si se alcanzó el límite de AniList.

        AniList devuelve un `total` ficticio (5000) mientras haya más páginas, así que el límite
        solo se detecta al llegar a RESULT_CAP resultados con `hasNextPage` todavía activo.
        """
        variables = dict(base)
        if lo_i is not None:
            variables["greater"] = lo_i - 1
        if hi_i is not None:
            variables["lesser"] = hi_i + 1
        key = hashlib.sha256(json.dumps(variables, sort_keys=True).encode()).hexdigest()
        cached = self.cache.get("anilist_query", key)
        if cached is not None:
            ids = [int(i) for i in cached]
            entries = self.repo.get_many([f"anilist:{i}" for i in ids])
            if len(entries) == len(ids):
                self.partitions.append(f"{lo_i}..{hi_i}: {len(ids)} (caché)")
                for i in ids:
                    if i not in seen:
                        seen.add(i)
                        yield entries[f"anilist:{i}"]
                return True

        ids: list[int] = []
        page = 1
        while True:
            page_data = self._page({**variables, "page": page, "perPage": PER_PAGE})
            batch = [normalize_media(m) for m in page_data.get("media") or [] if m]
            self.repo.save(batch)
            for e in batch:
                ids.append(e.anilist_id)  # type: ignore[arg-type]
                if e.anilist_id not in seen:
                    seen.add(e.anilist_id)  # type: ignore[arg-type]
                    yield e
            if not page_data["pageInfo"].get("hasNextPage"):
                break
            if page * PER_PAGE >= RESULT_CAP:
                return False
            page += 1
        self.partitions.append(f"{lo_i}..{hi_i}: {len(ids)}")
        self.cache.set("anilist_query", key, ids)
        return True

    def fetch_ids(self, anilist_ids: list[int] | None = None, mal_ids: list[int] | None = None, refresh: bool = False) -> dict[str, AnimeEntry]:
        """Obtiene entradas por ID en lotes de 50, usando la base local cuando está vigente."""
        out: dict[str, AnimeEntry] = {}
        anilist_ids = sorted(set(anilist_ids or []))
        if anilist_ids:
            uids = [f"anilist:{i}" for i in anilist_ids]
            cached = {} if refresh else self.repo.get_many(uids)
            out.update(cached)
            missing = [i for i in anilist_ids if f"anilist:{i}" not in cached]
            for i in range(0, len(missing), PER_PAGE):
                chunk = missing[i : i + PER_PAGE]
                data = self.graphql(IDS_QUERY, {"ids": chunk, "perPage": PER_PAGE})
                batch = [normalize_media(m) for m in data["Page"]["media"] or [] if m]
                self.repo.save(batch)
                out.update({e.uid: e for e in batch})
        for i in range(0, len(sorted(set(mal_ids or []))), PER_PAGE):
            chunk = sorted(set(mal_ids or []))[i : i + PER_PAGE]
            data = self.graphql(IDS_QUERY, {"idMals": chunk, "perPage": PER_PAGE})
            batch = [normalize_media(m) for m in data["Page"]["media"] or [] if m]
            self.repo.save(batch)
            out.update({e.uid: e for e in batch})
        return out

    def get(self, anilist_id: int) -> AnimeEntry | None:
        return self.fetch_ids([anilist_id]).get(f"anilist:{anilist_id}")

    def find_studios(self, name: str) -> list[dict[str, Any]]:
        data = self.graphql(STUDIO_SEARCH_QUERY, {"search": name})
        return data["Page"]["studios"] or []

    def iter_studio(self, name: str) -> Iterator[AnimeEntry]:
        """Itera todas las obras de un estudio (búsqueda dinámica por nombre, coincidencia exacta preferida)."""
        studios = self.find_studios(name)
        exact = [s for s in studios if s["name"].casefold() == name.casefold()]
        chosen = exact or studios[:1]
        if not chosen:
            log.warning("AniList: no se encontró el estudio %r", name)
            return
        for st in chosen:
            page = 1
            while True:
                self.pages_fetched += 1
                data = self.graphql(STUDIO_MEDIA_QUERY, {"id": st["id"], "page": page, "perPage": PER_PAGE})
                conn = data["Studio"]["media"]
                batch = [normalize_media(m) for m in conn["nodes"] or [] if m and m.get("type") == "ANIME"]
                self.repo.save(batch)
                yield from batch
                if not conn["pageInfo"].get("hasNextPage"):
                    break
                page += 1
