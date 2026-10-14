"""Clasificación de entradas según sus relaciones de AniList (secuela, spin-off, remake, recopilatorio).

Semántica observada en AniList (relationType version 2):
- PREQUEL/SEQUEL: continuidad narrativa; NO equivale a orden de estreno (p. ej. una OVA precuela posterior).
- PARENT: en una historia paralela, spin-off o recopilatorio apunta a la obra principal.
- SIDE_STORY / SPIN_OFF / SUMMARY: desde la obra principal hacia la derivada.
- ALTERNATIVE: otra versión de la misma historia (remakes, películas que adaptan lo mismo).
"""

from __future__ import annotations

from ..models import BROADCAST_FORMATS, AnimeEntry
from ..storage.database import Database


def _earlier(a: AnimeEntry, target_start: tuple[int, int, int] | None) -> bool:
    if target_start is None or not a.start_date.known:
        return False
    return target_start < a.start_date.sort_key()


def is_sequel(e: AnimeEntry) -> bool:
    """Tiene una precuela estrenada antes que ella."""
    for r in e.relations_of("PREQUEL"):
        if r.target_start and r.target_start.known and _earlier(e, r.target_start.sort_key()):
            return True
    return False


def is_spinoff(e: AnimeEntry) -> bool:
    """Serie (TV/ONA/TV_SHORT) que depende de una obra principal (relación PARENT)."""
    return e.format in BROADCAST_FORMATS and bool(e.relations_of("PARENT"))


def is_side_story(e: AnimeEntry) -> bool:
    """OVA/especial/película derivada de una obra principal (relación PARENT)."""
    return e.format not in BROADCAST_FORMATS and bool(e.relations_of("PARENT"))


def is_remake(e: AnimeEntry) -> bool:
    """Versión alternativa de una serie anterior (p. ej. Hunter x Hunter 2011 frente a 1999)."""
    if e.format not in BROADCAST_FORMATS:
        return False
    for r in e.relations_of("ALTERNATIVE"):
        if r.target_format in BROADCAST_FORMATS and r.target_start and _earlier(e, r.target_start.sort_key()):
            return True
    return False


def is_compilation(e: AnimeEntry, db: Database | None = None, known: dict[str, AnimeEntry] | None = None) -> bool:
    """Recopilatorio: otra obra la declara como SUMMARY, o ella misma declara COMPILATION."""
    if e.relations_of("COMPILATION"):
        return True
    for other in (known or {}).values():
        for r in other.relations_of("SUMMARY"):
            if r.target_uid == e.uid:
                return True
    if db is not None:
        row = db.conn.execute(
            "SELECT 1 FROM relations WHERE dst_uid=? AND relation_type='SUMMARY' LIMIT 1", (e.uid,)
        ).fetchone()
        if row:
            return True
    return False


def compilation_parents(e: AnimeEntry) -> list[str]:
    """Obras a consultar para saber si `e` es un recopilatorio (sus PARENT/ALTERNATIVE)."""
    return [r.target_uid for r in e.relations_of("PARENT", "ALTERNATIVE")]
