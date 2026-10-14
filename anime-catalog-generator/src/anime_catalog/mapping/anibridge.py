"""AniBridge mappings (github.com/anibridge/anibridge-mappings, MIT).

Formato (schema v3): objeto cuyas claves son descriptores de origen `provider:id[:scope]` y cuyos
valores son mapas de descriptores de destino -> {rango_origen: rango_destino}. Los mappings son
DIRECCIONALES: A -> B no implica B -> A. Se indexan tal cual; las búsquedas inversas se hacen con
el índice por destino, marcando el resultado como inverso.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from pathlib import Path

from .base import DatasetError, IndexRow, MappingDataset

DESCRIPTOR = re.compile(r"^(\w+):(\w+)(?::(\w+))?$")
KNOWN_PROVIDERS = {"anidb", "anilist", "mal", "imdb_movie", "imdb_show", "tmdb_show", "tmdb_movie", "tvdb_show", "tvdb_movie"}
SUPPORTED_MAJOR = "3"


def parse_descriptor(text: str) -> tuple[str, str, str | None]:
    m = DESCRIPTOR.match(text)
    if not m:
        raise DatasetError(f"descriptor inválido: {text!r}")
    return m.group(1), m.group(2), m.group(3)


def summarize_ranges(ranges: dict[str, str | None]) -> str:
    """Resume los rangos de episodios para auditoría (p. ej. '1-61>1-61')."""
    parts = [f"{k}>{v}" if v is not None else f"{k}>null" for k, v in list(ranges.items())[:6]]
    if len(ranges) > 6:
        parts.append("…")
    return ",".join(parts)


def count_episodes(ranges: dict[str, str | None]) -> int:
    total = 0
    for k, v in ranges.items():
        if v is None:
            continue
        a, _, b = k.partition("-")
        try:
            start = int(a)
            end = int(b) if b else start
            total += max(1, end - start + 1) if b != "" else 1
        except ValueError:
            continue
    return total


class AniBridgeDataset(MappingDataset):
    name = "anibridge"
    url = "https://github.com/anibridge/anibridge-mappings/releases/download/v3/mappings.json"
    filename = "mappings.json"
    license = "MIT"
    homepage = "https://github.com/anibridge/anibridge-mappings"
    lineage = frozenset({"anime-lists", "manami", "animeaggregations", "shinkro", "qlever", "anibridge-edits"})
    base_confidence = 0.95

    def version_of(self, path: Path) -> str | None:
        with path.open("rb") as fh:
            head = fh.read(4096).decode("utf-8", "ignore")
        m = re.search(r'"schema_version"\s*:\s*"([^"]+)"', head)
        g = re.search(r'"generated_on"\s*:\s*"([^"]+)"', head)
        if m:
            return f"{m.group(1)}@{g.group(1) if g else '?'}"
        return None

    def min_rows(self) -> int:
        return 50000

    def parse(self, path: Path) -> Iterator[IndexRow]:
        with path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict):
            raise DatasetError("AniBridge: la raíz debe ser un objeto")
        meta = data.get("$meta") or {}
        version = str(meta.get("schema_version") or "")
        if not version.startswith(SUPPORTED_MAJOR + "."):
            raise DatasetError(f"AniBridge: schema_version {version!r} no soportado (se espera {SUPPORTED_MAJOR}.x)")
        bad = 0
        for src, targets in data.items():
            if src.startswith("$"):
                continue
            try:
                sp, sid, sscope = parse_descriptor(src)
            except DatasetError:
                bad += 1
                continue
            if sp not in KNOWN_PROVIDERS or not isinstance(targets, dict):
                bad += 1
                continue
            for dst, ranges in targets.items():
                try:
                    dp, did, dscope = parse_descriptor(dst)
                except DatasetError:
                    bad += 1
                    continue
                if dp not in KNOWN_PROVIDERS:
                    bad += 1
                    continue
                ranges = ranges if isinstance(ranges, dict) else {}
                # Rangos explícitamente desmapeados (null) no aportan correspondencia.
                if ranges and all(v is None for v in ranges.values()):
                    continue
                detail = f"eps={count_episodes(ranges)};{summarize_ranges(ranges)}"
                yield (sp, sid, sscope, dp, did, dscope, detail)
        if bad > 1000:
            raise DatasetError(f"AniBridge: {bad} descriptores no reconocidos; ¿cambió el esquema?")
