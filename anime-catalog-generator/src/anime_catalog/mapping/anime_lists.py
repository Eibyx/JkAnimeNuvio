"""Anime-Lists (github.com/Anime-Lists/anime-lists): `anime-list-master.xml`, indexado por AniDB.

Respaldo opcional y desactivado por defecto: AniBridge, Kometa y Fribb ya incorporan estos datos.
Atributos usados: anidbid, tvdbid (número o 'movie'/'OVA'/'hentai'/'unknown'), defaulttvdbseason
('a' = absoluta), tmdbtv, tmdbseason, tmdbid (película, admite comas) e imdbid (admite comas).
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from xml.etree import ElementTree as ET

from .base import DatasetError, IndexRow, MappingDataset, split_ids


def _scope(value: str | None) -> str | None:
    if not value:
        return None
    if value == "a":
        return "sa"
    return f"s{value}" if value.isdigit() else None


class AnimeListsDataset(MappingDataset):
    name = "anime_lists"
    url = "https://raw.githubusercontent.com/Anime-Lists/anime-lists/master/anime-list-master.xml"
    filename = "anime-list-master.xml"
    license = "sin licencia declarada (uso como dato externo, no redistribuido)"
    homepage = "https://github.com/Anime-Lists/anime-lists"
    lineage = frozenset({"anime-lists"})
    base_confidence = 0.85
    enabled_by_default = False

    def parse(self, path: Path) -> Iterator[IndexRow]:
        with path.open("rb") as fh:
            head = fh.read(4096)
        if b"<!DOCTYPE" in head or b"<!ENTITY" in head:
            raise DatasetError("Anime-Lists: el XML contiene DOCTYPE/ENTITY; se rechaza por seguridad")
        if b"<anime-list" not in head:
            raise DatasetError("Anime-Lists: no es un anime-list XML")
        for _, el in ET.iterparse(path, events=("end",)):
            if el.tag != "anime":
                continue
            anidb = el.get("anidbid")
            if anidb and anidb.isdigit():
                tvdb = el.get("tvdbid") or ""
                if tvdb.isdigit():
                    yield ("anidb", anidb, None, "tvdb_show", tvdb, _scope(el.get("defaulttvdbseason")), f"kind={tvdb}")
                tmdbtv = el.get("tmdbtv") or ""
                if tmdbtv.isdigit():
                    yield ("anidb", anidb, None, "tmdb_show", tmdbtv, _scope(el.get("tmdbseason")), "")
                movies = [m for m in split_ids(el.get("tmdbid")) if m.isdigit()]
                for mv in movies:
                    yield ("anidb", anidb, None, "tmdb_movie", mv, None, f"movies={len(movies)}")
                for imdb in split_ids(el.get("imdbid")):
                    if imdb.startswith("tt"):
                        yield ("anidb", anidb, None, "imdb", imdb, None, "")
            el.clear()
