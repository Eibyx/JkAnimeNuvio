"""Proveedores: paginación/particionado de AniList, límites, normalización de Jikan, HTTP común."""

from __future__ import annotations

import copy
from datetime import date

import httpx
import pytest

from anime_catalog.http import HttpClient, HttpError, parse_retry_after, redact
from anime_catalog.providers import anilist as anilist_mod
from anime_catalog.providers.anilist import AniListClient, ServerFilters
from anime_catalog.providers.jikan import normalize_anime, _minutes
from anime_catalog.storage.cache import Cache
from anime_catalog.storage.database import Database
from anime_catalog.storage.repository import AnimeRepository

from .conftest import FakeAniList, no_sleep


def client(tmp_path, fake: FakeAniList) -> AniListClient:
    db = Database(tmp_path / "a.db")
    return AniListClient("https://graphql.anilist.test", AnimeRepository(db), Cache(db), transport=fake.transport(), sleep=no_sleep)


def many_media(raw_media, n: int) -> dict[int, dict]:
    base = raw_media[113415]
    out = {}
    for i in range(n):
        m = copy.deepcopy(base)
        m.update({"id": 500000 + i, "idMal": None, "relations": {"edges": []},
                  "startDate": {"year": 2021, "month": 1 + (i % 12), "day": 1 + (i % 28)}})
        out[m["id"]] = m
    return out


def test_full_pagination(tmp_path, raw_media):
    fake = FakeAniList(many_media(raw_media, 130))
    c = client(tmp_path, fake)
    got = list(c.iter_range(date(2021, 1, 1), date(2021, 12, 31), ServerFilters(formats=["TV"])))
    assert len(got) == 130 and len({e.uid for e in got}) == 130
    assert c.pages_fetched == 3


def test_partition_splits_when_result_cap_reached(tmp_path, raw_media, monkeypatch):
    monkeypatch.setattr(anilist_mod, "RESULT_CAP", 100)
    fake = FakeAniList(many_media(raw_media, 260))
    fake.page_cap = 100
    c = client(tmp_path, fake)
    got = list(c.iter_range(date(2021, 1, 1), date(2021, 12, 31), ServerFilters()))
    assert len({e.uid for e in got}) == 260  # nada se pierde aunque AniList corte en 100
    assert len(c.partitions) > 1


def test_multi_year_ranges_are_partitioned_by_year(tmp_path, fake_anilist):
    c = client(tmp_path, fake_anilist)
    got = list(c.iter_range(date(2020, 1, 1), date(2026, 12, 31), ServerFilters(formats=["TV"])))
    assert {e.anilist_id for e in got} >= {113415, 110277, 172463}
    assert len(c.partitions) == 7


def test_query_cache_avoids_requests(tmp_path, fake_anilist):
    c = client(tmp_path, fake_anilist)
    list(c.iter_range(date(2020, 1, 1), date(2020, 12, 31), ServerFilters()))
    n = len(fake_anilist.requests)
    list(c.iter_range(date(2020, 1, 1), date(2020, 12, 31), ServerFilters()))
    assert len(fake_anilist.requests) == n


def test_fetch_ids_batches_and_caches(tmp_path, fake_anilist):
    c = client(tmp_path, fake_anilist)
    got = c.fetch_ids([21, 16498, 999999])
    assert set(got) == {"anilist:21", "anilist:16498"}
    n = len(fake_anilist.requests)
    c.fetch_ids([21])
    assert len(fake_anilist.requests) == n


def test_rate_limit_header_adapts_interval(tmp_path):
    def handler(request):
        return httpx.Response(200, json={"data": {"Page": {"media": []}}}, headers={"X-RateLimit-Limit": "30", "X-RateLimit-Remaining": "29"})
    db = Database(tmp_path / "a.db")
    c = AniListClient("https://x", AnimeRepository(db), Cache(db), transport=httpx.MockTransport(handler), sleep=no_sleep)
    c.fetch_ids([1])
    assert c.http.limiter.min_interval == pytest.approx(60 / 30 + 0.05)


def test_http_retries_5xx_then_fails(tmp_path):
    n = {"c": 0}

    def handler(request):
        n["c"] += 1
        return httpx.Response(503, text="down")
    h = HttpClient("https://x", transport=httpx.MockTransport(handler), max_retries=2, sleep=no_sleep)
    with pytest.raises(HttpError):
        h.get_json("/a")
    assert n["c"] == 3


def test_retry_after_and_redaction():
    assert parse_retry_after("5") == 5.0
    assert parse_retry_after(None) is None
    assert "SECRET" not in redact("GET /x?apikey=SECRET&a=1", [])
    assert "abc123" not in redact("token abc123", ["abc123"])


def test_jikan_normalization():
    d = {
        "mal_id": 40748, "title": "Jujutsu Kaisen", "title_english": "Jujutsu Kaisen", "title_japanese": "呪術廻戦",
        "title_synonyms": ["JJK"], "type": "TV", "status": "Finished Airing", "episodes": 24, "duration": "23 min per ep",
        "aired": {"from": "2020-10-03T00:00:00+00:00", "to": "2021-03-27T00:00:00+00:00",
                  "prop": {"from": {"day": 3, "month": 10, "year": 2020}, "to": {"day": 27, "month": 3, "year": 2021}}},
        "score": 8.55, "scored_by": 2000000, "members": 3000000, "favorites": 50000, "season": "fall", "year": 2020,
        "studios": [{"mal_id": 569, "name": "MAPPA"}], "genres": [{"name": "Action"}], "themes": [{"name": "School"}],
        "demographics": [{"name": "Shounen"}], "rating": "R - 17+ (violence & profanity)", "source": "Manga",
        "relations": [{"relation": "Sequel", "entry": [{"mal_id": 51009, "type": "anime", "name": "JJK 2"}]},
                      {"relation": "Adaptation", "entry": [{"mal_id": 113138, "type": "manga", "name": "x"}]}],
    }
    e = normalize_anime(d)
    assert (e.uid, e.format, e.status, e.season, e.mal_score) == ("mal:40748", "TV", "FINISHED", "FALL", 8.55)
    assert e.start_date.year == 2020 and e.start_date.month == 10
    assert [r.target_uid for r in e.relations] == ["mal:51009"] and e.relations[0].relation_type == "SEQUEL"
    assert e.studios[0].name == "MAPPA" and not e.is_adult and e.duration == 23
    assert _minutes("1 hr 50 min") == 110
