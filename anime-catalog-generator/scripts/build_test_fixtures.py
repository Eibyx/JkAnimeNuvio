"""Regenera los fixtures de pruebas a partir de datos REALES (requiere red).

Extrae de los datasets publicados solo los registros de un conjunto pequeño de animes
(One Piece, Attack on Titan, Jujutsu Kaisen, Demon Slayer, Hunter x Hunter, El viaje de Chihiro...)
y guarda las respuestas de AniList para esas entradas. Las pruebas usan estos archivos sin red.

Uso: python scripts/build_test_fixtures.py <mappings.json> <anime_ids.json> <anime-list-full.json>
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from anime_catalog.providers.anilist import IDS_QUERY  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "tests" / "fixtures"
ANILIST_IDS = [
    21, 167404, 171630,  # One Piece, MONSTERS (precuela ONA), THE ONE PIECE (remake)
    16498, 20958, 99147, 104578, 110277, 131681, 146984, 20811, 18397, 119113, 21281, 20691,  # Attack on Titan
    113415, 145064, 172463, 209895, 131573,  # Jujutsu Kaisen (+ película 0)
    101922, 129874, 142329, 145139, 166240, 112151,  # Demon Slayer (+ Mugen Train)
    136, 11061,  # Hunter x Hunter 1999 / 2011
    199, 104461, 1047,  # El viaje de Chihiro, Heya Camp, película con mappings múltiples
]


def main(anibridge: str, kometa: str, fribb: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    media: list[dict] = []
    with httpx.Client(timeout=60) as c:
        for i in range(0, len(ANILIST_IDS), 50):
            r = c.post("https://graphql.anilist.co", json={"query": IDS_QUERY, "variables": {"ids": ANILIST_IDS[i:i + 50], "perPage": 50}})
            r.raise_for_status()
            media += r.json()["data"]["Page"]["media"]
            time.sleep(2)
    media.sort(key=lambda m: m["id"])
    (OUT / "anilist_media.json").write_text(json.dumps(media, ensure_ascii=False, indent=1), encoding="utf-8")
    mal_ids = {m["idMal"] for m in media if m.get("idMal")}
    keys = {f"anilist:{i}" for i in ANILIST_IDS} | {f"mal:{i}" for i in mal_ids}

    ab = json.loads(Path(anibridge).read_text(encoding="utf-8"))
    anidb = set()
    shows = set()
    for k in keys:
        for t in ab.get(k, {}):
            if t.startswith("anidb:"):
                anidb.add(t.split(":")[1])
            if t.startswith("tmdb_show:"):
                shows.add(t.split(":")[1])
    sub = {"$meta": ab["$meta"]}
    for k, v in ab.items():
        if k.startswith("$"):
            continue
        p = k.split(":")
        if k in keys or (p[0] == "anidb" and p[1] in anidb) or (p[0] == "tmdb_show" and p[1] in shows):
            sub[k] = v
    (OUT / "anibridge_mappings.json").write_text(json.dumps(sub, ensure_ascii=False, indent=1), encoding="utf-8")

    km = json.loads(Path(kometa).read_text(encoding="utf-8"))
    (OUT / "kometa_anime_ids.json").write_text(
        json.dumps({k: v for k, v in km.items() if k in anidb}, ensure_ascii=False, indent=1), encoding="utf-8")

    fr = json.loads(Path(fribb).read_text(encoding="utf-8"))
    (OUT / "fribb_anime_list.json").write_text(
        json.dumps([r for r in fr if str(r.get("anidb_id")) in anidb or r.get("anilist_id") in ANILIST_IDS], ensure_ascii=False, indent=1),
        encoding="utf-8")
    print(f"media={len(media)} anibridge={len(sub) - 1} anidb={len(anidb)}")


if __name__ == "__main__":
    main(*sys.argv[1:4])
