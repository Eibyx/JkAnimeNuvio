"""Fribb anime-lists (github.com/Fribb/anime-lists). El repositorio no declara licencia: los datos se
consumen en tiempo de ejecución y no se redistribuyen.

`anime-list-full.json` es una lista de objetos fusionados por AniDB ID. Diferencias relevantes:
- `themoviedb_id.tv` es un único entero (serie de TMDB).
- `themoviedb_id.movie` es una LISTA (una entrada de AniDB puede abarcar varias películas).
- `season.tmdb` / `season.tvdb` indican la temporada; `episode_offset` el desplazamiento.
- `imdb_id` es una lista.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

from .base import DatasetError, IndexRow, MappingDataset, iter_json_array


class FribbDataset(MappingDataset):
    name = "fribb"
    url = "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json"
    filename = "anime-list-full.json"
    license = "sin licencia declarada (uso como dato externo, no redistribuido)"
    homepage = "https://github.com/Fribb/anime-lists"
    lineage = frozenset({"anime-lists", "manami"})
    base_confidence = 0.88

    def parse(self, path: Path) -> Iterator[IndexRow]:
        malformed = 0
        total = 0
        for rec in iter_json_array(path):
            total += 1
            if not isinstance(rec, dict):
                malformed += 1
                continue
            tmdb = rec.get("themoviedb_id") or {}
            if not isinstance(tmdb, dict):
                malformed += 1
                continue
            season = rec.get("season") or {}
            offset = rec.get("episode_offset") or {}
            kind = rec.get("type") or "?"
            targets: list[tuple[str, str, str | None]] = []
            tv = tmdb.get("tv")
            if isinstance(tv, int):
                s = season.get("tmdb") if isinstance(season, dict) else None
                targets.append(("tmdb_show", str(tv), f"s{s}" if isinstance(s, int) else None))
            movies = tmdb.get("movie") or []
            if isinstance(movies, int):
                movies = [movies]
            for mv in movies:
                if isinstance(mv, int):
                    targets.append(("tmdb_movie", str(mv), None))
            if isinstance(rec.get("tvdb_id"), int):
                s = season.get("tvdb") if isinstance(season, dict) else None
                targets.append(("tvdb_show", str(rec["tvdb_id"]), f"s{s}" if isinstance(s, int) else None))
            for i in rec.get("imdb_id") or []:
                if isinstance(i, str) and i.startswith("tt"):
                    targets.append(("imdb", i, None))
            sources = [(p, str(rec[k])) for p, k in (("anidb", "anidb_id"), ("anilist", "anilist_id"), ("mal", "mal_id")) if isinstance(rec.get(k), int)]
            n_movies = len([t for t in targets if t[0] == "tmdb_movie"])
            detail = f"type={kind};movies={n_movies};offset={offset.get('tmdb', 0) if isinstance(offset, dict) else 0}"
            for sp, sid in sources:
                for dp, did, dscope in targets:
                    yield (sp, sid, None, dp, did, dscope, detail)
                for op, oid in sources:
                    if op != sp:
                        yield (sp, sid, None, op, oid, None, detail)
        if malformed > max(50, total * 0.05):
            raise DatasetError(f"Fribb: {malformed} entradas mal formadas; ¿cambió el esquema?")
