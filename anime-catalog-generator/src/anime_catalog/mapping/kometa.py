"""Kometa Anime IDs (github.com/Kometa-Team/Anime-IDs, MIT).

`anime_ids.json` usa el ID de AniDB como clave. Campos observados: tvdb_id, tvdb_season
(-1 = numeración absoluta, 0 = especiales), tvdb_epoffset, mal_id, anilist_id, imdb_id y, según
la documentación, tmdb_movie_id / tmdb_show_id. Algunos campos pueden ser cadenas con varios IDs
separados por comas ("849,4382"); por eso se construyen índices secundarios por cada valor.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

from .base import DatasetError, IndexRow, MappingDataset, iter_json_object, split_ids

KNOWN_FIELDS = {"tvdb_id", "tvdb_season", "tvdb_epoffset", "mal_id", "anilist_id", "imdb_id", "tmdb_movie_id", "tmdb_show_id"}


def tvdb_scope(season: object) -> str | None:
    try:
        s = int(season)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return "sa" if s < 0 else f"s{s}"


class KometaDataset(MappingDataset):
    name = "kometa"
    url = "https://raw.githubusercontent.com/Kometa-Team/Anime-IDs/master/anime_ids.json"
    filename = "anime_ids.json"
    license = "MIT"
    homepage = "https://github.com/Kometa-Team/Anime-IDs"
    lineage = frozenset({"anime-lists", "manami", "animeaggregations"})
    base_confidence = 0.88

    def parse(self, path: Path) -> Iterator[IndexRow]:
        unknown = 0
        total = 0
        for anidb, rec in iter_json_object(path):
            total += 1
            if not str(anidb).isdigit() or not isinstance(rec, dict):
                unknown += 1
                continue
            if set(rec) - KNOWN_FIELDS:
                unknown += 1
            anilist = split_ids(rec.get("anilist_id"))
            mal = split_ids(rec.get("mal_id"))
            imdb = [i for i in split_ids(rec.get("imdb_id")) if i.startswith("tt")]
            multi = "multi" if (len(anilist) > 1 or len(mal) > 1) else "single"
            targets: list[tuple[str, str, str | None]] = []
            if rec.get("tvdb_id"):
                targets.append(("tvdb_show", str(rec["tvdb_id"]), tvdb_scope(rec.get("tvdb_season"))))
            for i in imdb:
                targets.append(("imdb", i, None))
            for t in split_ids(rec.get("tmdb_movie_id")):
                targets.append(("tmdb_movie", t, None))
            for t in split_ids(rec.get("tmdb_show_id")):
                targets.append(("tmdb_show", t, None))
            detail = f"{multi};epoffset={rec.get('tvdb_epoffset', 0)}"
            sources = [("anidb", str(anidb))] + [("anilist", a) for a in anilist] + [("mal", m) for m in mal]
            for sp, sid in sources:
                for dp, did, dscope in targets:
                    yield (sp, sid, None, dp, did, dscope, detail)
                # Correspondencias cruzadas entre identificadores de anime.
                for op, oid in sources:
                    if (op, oid) != (sp, sid) and op != sp:
                        yield (sp, sid, None, op, oid, None, detail)
        if unknown > max(50, total * 0.05):
            raise DatasetError(f"Kometa: {unknown} entradas con formato desconocido; ¿cambió el esquema?")
