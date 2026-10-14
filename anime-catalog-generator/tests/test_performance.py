"""Rendimiento del mapping: memoria del indexado en streaming, consultas por lotes, caché persistente
y concurrencia de TMDB. Las pruebas usan márgenes amplios para no depender de la máquina.

La medición completa con los datasets REALES está en `scripts/benchmark_mapping.py` y en la prueba
opcional `test_real_dataset_benchmark` (ANIME_CATALOG_BENCHMARK=1).
"""

from __future__ import annotations

import gc
import json
import os
import subprocess
import sys
import time
import tracemalloc
from pathlib import Path

import httpx
import pytest

from anime_catalog.config import MappingConfig
from anime_catalog.mapping.anibridge import AniBridgeDataset
from anime_catalog.mapping.index import MappingIndex
from anime_catalog.mapping.resolver import MappingResolver
from anime_catalog.models import AnimeEntry, MappingStatus
from anime_catalog.providers.tmdb import TMDBClient
from anime_catalog.storage.cache import Cache
from anime_catalog.storage.database import Database

from .conftest import no_sleep

ROOT = Path(__file__).resolve().parents[1]


def synthetic_anibridge(path: Path, n: int) -> None:
    data: dict = {"$meta": {"schema_version": "3.0.3", "generated_on": "2026-10-14T00:00:00Z"}}
    for i in range(1, n + 1):
        data[f"anilist:{i}"] = {
            f"mal:{i}": {"1-12": "1-12"}, f"anidb:{i}:R": {"1-12": "1-12"},
            f"tmdb_show:{100000 + i}:s1": {"1-12": "1-12"}, f"tvdb_show:{200000 + i}:s1": {"1-12": "1-12"},
        }
        data[f"tmdb_show:{100000 + i}:s1"] = {f"anilist:{i}": {"1-12": "1-12"}}
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


class BigAniBridge(AniBridgeDataset):
    def min_rows(self) -> int:
        return 10


@pytest.fixture(scope="module")
def big_index(tmp_path_factory):
    d = tmp_path_factory.mktemp("perf")
    src = d / "mappings.json"
    synthetic_anibridge(src, 6000)
    db = Database(d / "perf.db")
    ds = BigAniBridge(d / "ds")
    t = time.perf_counter()
    res = ds.install(db, src, {"sha256": "x"})
    elapsed = time.perf_counter() - t
    assert res.status == "updated" and res.rows == 6000 * 5
    return db, src, elapsed


def entries(n: int) -> list[AnimeEntry]:
    return [AnimeEntry(provider="anilist", anilist_id=i, format="TV", title_romaji=str(i)) for i in range(1, n + 1)]


def test_streaming_index_uses_much_less_memory_than_json_load(tmp_path):
    src = tmp_path / "mappings.json"
    synthetic_anibridge(src, 6000)
    gc.collect()
    tracemalloc.start()
    data = json.loads(src.read_text(encoding="utf-8"))
    _, peak_load = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    del data
    gc.collect()
    db = Database(tmp_path / "m.db")
    tracemalloc.start()
    BigAniBridge(tmp_path / "ds").install(db, src, {"sha256": "x"})
    _, peak_stream = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    # El indexado completo (análisis + inserción) usa bastante menos que solo cargar el JSON entero.
    assert peak_stream < peak_load * 0.7, (peak_stream, peak_load)


def test_indexing_speed(big_index):
    _, _, elapsed = big_index
    assert elapsed < 20  # 30.000 filas; en la práctica < 1 s


def test_batch_prefetch_minimizes_sql_queries(big_index):
    db, _, _ = big_index
    es = entries(5000)
    lazy = MappingResolver(db, MappingIndex(db), MappingConfig(), None)
    for e in es[:500]:
        lazy.resolve_entry(e)
    per_entry_queries = lazy.index.queries
    batched = MappingResolver(db, MappingIndex(db), MappingConfig(), None)
    t = time.perf_counter()
    results = batched.resolve_many(es)
    elapsed = time.perf_counter() - t
    assert all(r.tmdb_id == 100000 + i for i, r in enumerate(results, start=1))
    assert per_entry_queries >= 500 * 2  # sin precarga: varias consultas por anime
    assert batched.index.queries < 120  # con precarga: consultas IN por bloques para 5.000 animes
    assert elapsed < 15


def test_resolution_scaling(big_index):
    db, _, _ = big_index
    timings = {}
    for n in (100, 1000, 5000):
        r = MappingResolver(db, MappingIndex(db), MappingConfig(), None)
        t = time.perf_counter()
        r.resolve_many(entries(n))
        timings[n] = time.perf_counter() - t
    assert timings[5000] < 15
    # Escala de forma aproximadamente lineal (sin explosiones cuadráticas).
    assert timings[5000] < max(timings[1000], 0.05) * 12


def _slow_tmdb(delay: float, calls: list[str]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        time.sleep(delay)
        tid = int(request.url.path.rsplit("/", 1)[-1])
        return httpx.Response(200, json={"id": tid, "name": f"Show {tid - 100000}", "original_name": f"Show {tid - 100000}",
                                         "first_air_date": "2020-01-01", "original_language": "ja", "genres": [{"id": 16}],
                                         "external_ids": {"tvdb_id": tid + 100000}})
    return httpx.MockTransport(handler)


def test_tmdb_prefetch_is_concurrent_and_cached(tmp_path):
    db = Database(tmp_path / "t.db")
    items = [("tv", 100000 + i) for i in range(1, 21)]
    calls: list[str] = []
    seq = TMDBClient("https://tmdb.test/3", Cache(db), api_key="k", transport=_slow_tmdb(0.05, calls), sleep=no_sleep)
    seq.http.limiter.min_interval = 0
    t = time.perf_counter()
    seq.prefetch_details(items, workers=1)
    sequential = time.perf_counter() - t
    db2 = Database(tmp_path / "t2.db")
    par = TMDBClient("https://tmdb.test/3", Cache(db2), api_key="k", transport=_slow_tmdb(0.05, calls), sleep=no_sleep)
    par.http.limiter.min_interval = 0
    t = time.perf_counter()
    assert par.prefetch_details(items, workers=4) == 20
    concurrent = time.perf_counter() - t
    assert concurrent < sequential * 0.6, (concurrent, sequential)
    before = len(calls)
    assert par.prefetch_details(items, workers=4) == 0  # todo en caché: ninguna solicitud
    assert len(calls) == before


def test_persistent_resolution_cache_avoids_tmdb_on_next_run(big_index, tmp_path):
    db, _, _ = big_index
    calls: list[str] = []
    tmdb = TMDBClient("https://tmdb.test/3", Cache(db), api_key="k", transport=_slow_tmdb(0, calls), sleep=no_sleep)
    es = [AnimeEntry(provider="anilist", anilist_id=i, format="TV", title_romaji=f"Show {i}") for i in range(1, 51)]
    first = MappingResolver(db, MappingIndex(db), MappingConfig(), tmdb, cache=Cache(db))
    res = first.resolve_many(es)
    assert all(r.status in (MappingStatus.CONFIRMED, MappingStatus.HIGH_CONFIDENCE) for r in res)
    assert first.stats["tmdb_prefetched"] == 50
    n_calls = len(calls)
    second = MappingResolver(db, MappingIndex(db), MappingConfig(), tmdb, cache=Cache(db))
    second.resolve_many(es)
    assert second.stats["persistent_hits"] == 50 and second.stats["computed"] == 0
    assert len(calls) == n_calls  # la segunda ejecución no toca TMDB


def test_dataset_unchanged_is_not_reprocessed(tmp_path):
    from anime_catalog.mapping.updater import MappingUpdater
    src = tmp_path / "src.json"
    synthetic_anibridge(src, 50)
    body = src.read_bytes()
    calls: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(dict(request.headers))
        if request.headers.get("if-none-match") == '"v1"':
            return httpx.Response(304)
        return httpx.Response(200, content=body, headers={"ETag": '"v1"'})

    import anime_catalog.mapping.index as idx
    old = idx.DATASET_CLASSES["anibridge"]
    idx.DATASET_CLASSES["anibridge"] = BigAniBridge
    try:
        db = Database(tmp_path / "u.db")
        up = MappingUpdater(db, tmp_path / "ds", transport=httpx.MockTransport(handler), sleep=no_sleep)
        assert up.update(["anibridge"])[0].status == "updated"
        t = time.perf_counter()
        assert up.update(["anibridge"])[0].status == "unchanged"
        assert time.perf_counter() - t < 1.0
        assert calls[-1].get("if-none-match") == '"v1"'
    finally:
        idx.DATASET_CLASSES["anibridge"] = old


@pytest.mark.benchmark
@pytest.mark.skipif(os.environ.get("ANIME_CATALOG_BENCHMARK") != "1", reason="benchmark con datasets reales (ANIME_CATALOG_BENCHMARK=1)")
def test_real_dataset_benchmark(tmp_path):
    work = Path(os.environ.get("ANIME_CATALOG_BENCH_DIR", tmp_path))
    out = subprocess.run([sys.executable, str(ROOT / "scripts" / "benchmark_mapping.py"), "--work", str(work)],
                         capture_output=True, text=True, timeout=1800, check=True)
    report = json.loads(out.stdout[out.stdout.index("{"):])
    assert report["index"]["anibridge"]["rows"] > 200000
    assert report["index"]["peak_rss_mb"] < 150
    assert report["resolve"][-1]["n"] == 5000 and report["resolve"][-1]["cold_seconds"] < 10
