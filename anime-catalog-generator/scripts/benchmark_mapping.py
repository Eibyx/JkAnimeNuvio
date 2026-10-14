"""Benchmark del mapping local con los datasets REALES (AniBridge, Kometa, Fribb).

Cada fase se ejecuta en un proceso hijo para medir su memoria máxima (ru_maxrss) por separado.

    python scripts/benchmark_mapping.py --work /tmp/bench            # usa datasets ya descargados si existen
    python scripts/benchmark_mapping.py --work /tmp/bench --download # mide también la descarga
    python scripts/benchmark_mapping.py --work /tmp/bench --json out.json

Fases:
  download  descarga inicial (red) de los tres datasets
  index     validación + indexación en SQLite desde los archivos locales
  query     consulta individual (resolve_entry de un anime), fría y caliente
  resolve   resolución de 100 / 1.000 / 5.000 animes (caché fría y caliente)
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import random
import resource
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

SOURCES = ["anibridge", "kometa", "fribb"]


def rss_mb() -> float:
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(r / 1024 if sys.platform != "darwin" else r / 1024 / 1024, 1)


def phase_download(work: Path) -> dict:
    from anime_catalog.mapping.index import DATASET_CLASSES
    from anime_catalog.http import HttpClient
    out = {}
    http = HttpClient("", timeout=300, headers={"Accept": "*/*"})
    for s in SOURCES:
        ds = DATASET_CLASSES[s](work / "datasets")
        ds.dir.mkdir(parents=True, exist_ok=True)
        t = time.perf_counter()
        with http.client.stream("GET", ds.url) as resp:
            resp.raise_for_status()
            size = 0
            with ds.path.open("wb") as fh:
                for chunk in resp.iter_bytes(1 << 20):
                    fh.write(chunk)
                    size += len(chunk)
        out[s] = {"seconds": round(time.perf_counter() - t, 2), "mb": round(size / 1e6, 1)}
    out["peak_rss_mb"] = rss_mb()
    return out


def phase_index(work: Path) -> dict:
    import hashlib

    from anime_catalog.mapping.index import DATASET_CLASSES
    from anime_catalog.storage.database import Database
    db_path = work / "bench.db"
    for p in work.glob("bench.db*"):
        p.unlink()
    db = Database(db_path)
    out = {}
    total = time.perf_counter()
    for s in SOURCES:
        ds = DATASET_CLASSES[s](work / "datasets")
        tmp = ds.dir / (ds.filename + ".bench")
        shutil.copyfile(ds.path, tmp)
        t = time.perf_counter()
        res = ds.install(db, tmp, {"sha256": hashlib.sha256(tmp.read_bytes()).hexdigest()})
        out[s] = {"seconds": round(time.perf_counter() - t, 2), "rows": res.rows, "status": res.status}
        if tmp.exists():
            tmp.unlink()
    out["total_seconds"] = round(time.perf_counter() - total, 2)
    db.close()
    out["db_mb"] = round(sum(p.stat().st_size for p in work.glob("bench.db*")) / 1e6, 1)
    out["peak_rss_mb"] = rss_mb()
    return out


def _sample_entries(db, n: int, seed: int = 7):
    from anime_catalog.models import AnimeEntry
    rows = db.conn.execute(
        "SELECT DISTINCT src_id FROM mapping_index WHERE source='anibridge' AND src_provider='anilist'"
    ).fetchall()
    ids = sorted(int(r[0]) for r in rows)
    rnd = random.Random(seed)
    chosen = rnd.sample(ids, min(n, len(ids)))
    movies = {int(r[0]) for r in db.conn.execute(
        "SELECT DISTINCT src_id FROM mapping_index WHERE source='anibridge' AND src_provider='anilist' AND dst_provider='tmdb_movie'")}
    return [AnimeEntry(provider="anilist", anilist_id=i, format="MOVIE" if i in movies else "TV", title_romaji=str(i)) for i in chosen]


def _resolver(db):
    from anime_catalog.config import MappingConfig
    from anime_catalog.mapping.index import MappingIndex
    from anime_catalog.mapping.resolver import MappingResolver
    from anime_catalog.storage.cache import Cache
    try:
        return MappingResolver(db, MappingIndex(db), MappingConfig(), None, cache=Cache(db))
    except TypeError:  # versión anterior sin caché persistente
        return MappingResolver(db, MappingIndex(db), MappingConfig(), None)


def phase_query(work: Path) -> dict:
    from anime_catalog.models import AnimeEntry
    from anime_catalog.storage.database import Database
    db = Database(work / "bench.db")
    t0 = time.perf_counter()
    r = _resolver(db)
    startup = time.perf_counter() - t0
    e = AnimeEntry(provider="anilist", anilist_id=21, mal_id=21, format="TV", title_romaji="ONE PIECE")
    t = time.perf_counter()
    res = r.resolve_entry(e)
    cold = time.perf_counter() - t
    samples = _sample_entries(db, 200, seed=3)
    t = time.perf_counter()
    for s in samples:
        _resolver(db).resolve_entry(s)
    per = (time.perf_counter() - t) / len(samples)
    t = time.perf_counter()
    r.resolve_entry(e)
    warm = time.perf_counter() - t
    return {"resolver_startup_ms": round(startup * 1000, 2), "one_piece_cold_ms": round(cold * 1000, 2),
            "avg_uncached_ms_200": round(per * 1000, 3), "one_piece_warm_ms": round(warm * 1000, 4),
            "result": f"{res.media_type}:{res.tmdb_id} {res.status.value}", "peak_rss_mb": rss_mb()}


def phase_resolve(work: Path, n: int) -> dict:
    from anime_catalog.storage.database import Database
    db = Database(work / "bench.db")
    entries = _sample_entries(db, n)
    db.conn.execute("DELETE FROM cache WHERE namespace='resolution'")  # caché persistente fría
    db.close()
    db = Database(work / "bench.db")  # conexión nueva: caché de SQLite fría
    r = _resolver(db)
    t = time.perf_counter()
    statuses: dict[str, int] = {}
    results = r.resolve_many(entries) if hasattr(r, "resolve_many") else [r.resolve_entry(e) for e in entries]
    for res in results:
        statuses[res.status.value] = statuses.get(res.status.value, 0) + 1
    cold = time.perf_counter() - t
    t = time.perf_counter()
    for e in entries:
        r.resolve_entry(e)
    warm_same = time.perf_counter() - t
    # Nueva ejecución (proceso "siguiente"): resolutor nuevo, caché persistente de SQLite.
    r2 = _resolver(db)
    t = time.perf_counter()
    if hasattr(r2, "resolve_many"):
        r2.resolve_many(entries)
    else:
        for e in entries:
            r2.resolve_entry(e)
    warm_new = time.perf_counter() - t
    return {"n": len(entries), "cold_seconds": round(cold, 3), "warm_same_run_seconds": round(warm_same, 4),
            "warm_next_run_seconds": round(warm_new, 3), "per_anime_cold_ms": round(cold / len(entries) * 1000, 3),
            "statuses": statuses, "peak_rss_mb": rss_mb()}


def run_child(args: list[str]) -> dict:
    out = subprocess.run([sys.executable, __file__, *args], capture_output=True, text=True, check=True)
    return json.loads(out.stdout.strip().splitlines()[-1])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", type=Path, required=True)
    ap.add_argument("--download", action="store_true")
    ap.add_argument("--json", type=Path)
    ap.add_argument("--phase")
    ap.add_argument("--n", type=int, default=100)
    a = ap.parse_args()
    a.work.mkdir(parents=True, exist_ok=True)
    if a.phase:
        fn = {"download": phase_download, "index": phase_index, "query": phase_query}.get(a.phase)
        res = fn(a.work) if fn else phase_resolve(a.work, a.n)
        print(json.dumps(res))
        return
    report: dict = {"python": sys.version.split()[0], "platform": platform.platform(), "machine": platform.machine(),
                    "cpus": os.cpu_count()}
    if a.download or not all((a.work / "datasets" / s).exists() for s in SOURCES):
        report["download"] = run_child(["--work", str(a.work), "--phase", "download"])
    report["index"] = run_child(["--work", str(a.work), "--phase", "index"])
    report["query"] = run_child(["--work", str(a.work), "--phase", "query"])
    report["resolve"] = [run_child(["--work", str(a.work), "--phase", "resolve", "--n", str(n)]) for n in (100, 1000, 5000)]
    text = json.dumps(report, indent=2, ensure_ascii=False)
    print(text)
    if a.json:
        a.json.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
