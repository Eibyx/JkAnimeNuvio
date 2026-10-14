"""Cliente de Jikan API v4 (MyAnimeList no oficial, https://docs.api.jikan.moe/).

Se usa como fuente alternativa (`source.primary: myanimelist`) o complementaria (`hybrid`: AniList es
la fuente principal y Jikan aporta la puntuación de MAL y su número de votos).

Normalización a los valores de AniList:
- type: "TV"->TV, "Movie"->MOVIE, "OVA"->OVA, "ONA"->ONA, "Special"/"TV Special"->SPECIAL, "Music"->MUSIC
- status: "Finished Airing"->FINISHED, "Currently Airing"->RELEASING, "Not yet aired"->NOT_YET_RELEASED
- géneros de MAL -> genres; temas y demografías -> tags (sin relevancia: rank=None)
- relaciones de MAL -> tipos de AniList (Prequel->PREQUEL, Parent Story->PARENT, ...)
- puntuación MAL en escala 0-10 (`mal_score`), sin mezclarla con las de AniList.

Límites públicos de Jikan: 3 solicitudes/s y 60/min; se respeta un intervalo de 1,1 s.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from datetime import date
from typing import Any

import httpx

from ..http import HttpClient, HttpError
from ..models import AnimeEntry, FuzzyDate, Relation, Studio, Tag
from ..storage.cache import Cache
from ..storage.repository import AnimeRepository

log = logging.getLogger(__name__)

TYPE_MAP = {"TV": "TV", "Movie": "MOVIE", "OVA": "OVA", "ONA": "ONA", "Special": "SPECIAL", "TV Special": "SPECIAL", "Music": "MUSIC"}
STATUS_MAP = {"Finished Airing": "FINISHED", "Currently Airing": "RELEASING", "Not yet aired": "NOT_YET_RELEASED"}
RELATION_MAP = {
    "Prequel": "PREQUEL", "Sequel": "SEQUEL", "Parent Story": "PARENT", "Side Story": "SIDE_STORY",
    "Summary": "SUMMARY", "Alternative Version": "ALTERNATIVE", "Alternative Setting": "ALTERNATIVE",
    "Spin-Off": "SPIN_OFF", "Character": "CHARACTER", "Full Story": "PARENT", "Adaptation": "SOURCE", "Other": "OTHER",
}
SOURCE_MAP = {"Manga": "MANGA", "Light novel": "LIGHT_NOVEL", "Original": "ORIGINAL", "Visual novel": "VISUAL_NOVEL",
              "Web manga": "MANGA", "Novel": "NOVEL", "Web novel": "WEB_NOVEL", "Game": "GAME", "4-koma manga": "MANGA",
              "Other": "OTHER", "Card game": "GAME", "Book": "NOVEL", "Picture book": "PICTURE_BOOK", "Music": "OTHER",
              "Mixed media": "MULTIMEDIA_PROJECT"}
TYPE_PARAM = {"TV": "tv", "MOVIE": "movie", "OVA": "ova", "ONA": "ona", "SPECIAL": "special", "MUSIC": "music"}


def _prop_date(aired: dict[str, Any] | None, key: str) -> FuzzyDate:
    prop = ((aired or {}).get("prop") or {}).get(key) or {}
    if prop.get("year"):
        return FuzzyDate(year=prop.get("year"), month=prop.get("month"), day=prop.get("day"))
    return FuzzyDate.from_iso((aired or {}).get(key))


def _minutes(duration: str | None) -> int | None:
    if not duration:
        return None
    total = 0
    parts = duration.replace(".", "").split()
    for i, p in enumerate(parts):
        if p.isdigit() and i + 1 < len(parts):
            unit = parts[i + 1].lower()
            if unit.startswith("hr"):
                total += int(p) * 60
            elif unit.startswith("min"):
                total += int(p)
    return total or None


def normalize_anime(d: dict[str, Any], relations: list[dict[str, Any]] | None = None) -> AnimeEntry:
    rels = []
    for group in relations if relations is not None else d.get("relations") or []:
        rtype = RELATION_MAP.get(group.get("relation", ""), "OTHER")
        for ent in group.get("entry") or []:
            if ent.get("type") == "anime" and ent.get("mal_id"):
                rels.append(Relation(relation_type=rtype, target_uid=f"mal:{ent['mal_id']}", target_type="ANIME",
                                     target_title=ent.get("name")))
    tags = [Tag(name=x["name"], rank=None, category="Theme") for x in d.get("themes") or [] if x.get("name")]
    tags += [Tag(name=x["name"], rank=None, category="Demographic") for x in d.get("demographics") or [] if x.get("name")]
    rating = d.get("rating") or ""
    return AnimeEntry(
        provider="myanimelist",
        mal_id=d["mal_id"],
        title_romaji=d.get("title"),
        title_english=d.get("title_english"),
        title_native=d.get("title_japanese"),
        synonyms=[s for s in d.get("title_synonyms") or [] if s],
        start_date=_prop_date(d.get("aired"), "from"),
        end_date=_prop_date(d.get("aired"), "to"),
        season=(d.get("season") or "").upper() or None,
        season_year=d.get("year"),
        format=TYPE_MAP.get(d.get("type") or ""),
        status=STATUS_MAP.get(d.get("status") or ""),
        episodes=d.get("episodes"),
        duration=_minutes(d.get("duration")),
        popularity=d.get("members"),
        favourites=d.get("favorites"),
        genres=[g["name"] for g in (d.get("genres") or []) + (d.get("explicit_genres") or []) if g.get("name")],
        tags=tags,
        studios=[Studio(name=s["name"], is_main=True) for s in d.get("studios") or [] if s.get("name")],
        country="JP",
        source=SOURCE_MAP.get(d.get("source") or "", (d.get("source") or "").upper() or None),
        is_adult=rating.startswith("Rx"),
        relations=rels,
        mal_score=d.get("score"),
        mal_scored_by=d.get("scored_by"),
        mal_members=d.get("members"),
    )


class JikanClient:
    def __init__(self, base_url: str, repo: AnimeRepository, cache: Cache, *, transport: httpx.BaseTransport | None = None,
                 timeout: float = 60.0, sleep: Any = None):
        kwargs: dict[str, Any] = {"sleep": sleep} if sleep is not None else {}
        self.http = HttpClient(base_url.rstrip("/"), timeout=timeout, min_interval=1.1, transport=transport, name="Jikan", **kwargs)
        self.repo = repo
        self.cache = cache
        self.pages_fetched = 0

    def close(self) -> None:
        self.http.close()

    def anime(self, mal_id: int, full: bool = True) -> AnimeEntry | None:
        uid = f"mal:{mal_id}"
        # Solo la ficha completa (/full) trae relaciones; el listado /anime no.
        cached = self.repo.get(uid)
        if cached is not None and (not full or self.cache.get("jikan_full", uid) is not None):
            return cached
        resp = self.http.request("GET", f"/anime/{mal_id}/full" if full else f"/anime/{mal_id}")
        if resp.status_code == 404:
            return None
        if resp.status_code != 200:
            raise HttpError(f"Jikan: HTTP {resp.status_code} en /anime/{mal_id}", status=resp.status_code)
        e = normalize_anime(resp.json()["data"])
        self.repo.save([e])
        if full:
            self.cache.set("jikan_full", uid, True, ttl=self.cache.ttl_for("jikan"))
        return e

    def fetch_ids(self, mal_ids: list[int]) -> dict[str, AnimeEntry]:
        out: dict[str, AnimeEntry] = {}
        for i in sorted(set(mal_ids)):
            try:
                e = self.anime(i)
            except HttpError as err:
                log.warning("Jikan: no se pudo obtener mal:%s: %s", i, err)
                continue
            if e:
                out[e.uid] = e
        return out

    def scores(self, mal_id: int) -> dict[str, Any] | None:
        """Puntuación MAL para el modo híbrido (score 0-10, scored_by, members)."""
        key = str(mal_id)
        cached = self.cache.get("jikan", key)
        if cached is not None:
            return cached
        resp = self.http.request("GET", f"/anime/{mal_id}")
        if resp.status_code != 200:
            return None
        d = resp.json().get("data") or {}
        out = {"score": d.get("score"), "scored_by": d.get("scored_by"), "members": d.get("members")}
        self.cache.set("jikan", key, out)
        return out

    def iter_range(self, lo: date | None, hi: date | None, formats: list[str] | None = None, sfw: bool = True) -> Iterator[AnimeEntry]:
        """Búsqueda paginada /anime con rango de fechas, particionada por años."""
        y0 = lo.year if lo else 1917
        y1 = hi.year if hi else date.today().year + 3
        types = [TYPE_PARAM[f] for f in formats or [] if f in TYPE_PARAM] or [None]
        seen: set[int] = set()
        for year in range(y0, y1 + 1):
            for t in types:
                page = 1
                while True:
                    params: dict[str, Any] = {
                        "start_date": f"{year}-01-01", "end_date": f"{year}-12-31", "order_by": "start_date",
                        "sort": "asc", "page": page, "limit": 25,
                    }
                    if t:
                        params["type"] = t
                    if sfw:
                        params["sfw"] = "true"
                    self.pages_fetched += 1
                    body = self.http.get_json("/anime", params=params)
                    batch = []
                    for d in body.get("data") or []:
                        e = normalize_anime(d, relations=[])
                        # El listado no trae relaciones; si ya teníamos la ficha completa, se conserva.
                        old = self.repo.get(e.uid, allow_stale=True)
                        if old and old.relations:
                            e.relations = old.relations
                        batch.append(e)
                    self.repo.save(batch)
                    for e in batch:
                        if e.mal_id not in seen:
                            seen.add(e.mal_id)  # type: ignore[arg-type]
                            yield e
                    if not (body.get("pagination") or {}).get("has_next_page"):
                        break
                    page += 1
