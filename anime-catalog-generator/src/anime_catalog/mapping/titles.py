"""Normalización y comparación de títulos (solo como evidencia secundaria, nunca como clave)."""

from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher

_NOISE = re.compile(
    r"\b(the|tv|season|part|cour|series|anime|movie|film|gekijouban|the animation)\b|[\s\-:;,.!?'\"()\[\]{}~☆★♪/\\|_]+",
    re.I,
)


def normalize(title: str) -> str:
    t = unicodedata.normalize("NFKC", title or "").casefold()
    t = t.replace("×", "x").replace("&", "and")
    t = _NOISE.sub(" ", t)
    return re.sub(r"\s+", " ", t).strip()


def similarity(a: str, b: str) -> float:
    na, nb = normalize(a), normalize(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    ratio = SequenceMatcher(None, na, nb).ratio()
    ta, tb = set(na.split()), set(nb.split())
    jacc = len(ta & tb) / len(ta | tb) if ta | tb else 0.0
    return max(ratio, jacc)


def best_similarity(left: list[str], right: list[str]) -> tuple[float, str, str]:
    best = (0.0, "", "")
    for a in left:
        for b in right:
            s = similarity(a, b)
            if s > best[0]:
                best = (s, a, b)
    return best
