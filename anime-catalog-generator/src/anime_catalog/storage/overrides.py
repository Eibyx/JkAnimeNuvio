"""Overrides manuales en YAML (versionables en Git) sincronizados con la tabla `overrides`.

Formato:

    overrides:
      - uid: anilist:12345        # entrada de AniList (o mal:12345)
        action: map               # map | exclude | canonical
        media_type: tv            # map: tv | movie
        tmdb_id: 54321            # map: ID de TMDB
        note: "motivo"
      - uid: anilist:999
        action: exclude
      - uid: anilist:777
        action: canonical         # fuerza que pertenezca al grupo de otra entrada
        canonical_uid: anilist:21
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from .database import Database


def import_overrides(db: Database, path: Path) -> int:
    if not path.is_file():
        return 0
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    items = data.get("overrides") if isinstance(data, dict) else None
    if not isinstance(items, list):
        raise ValueError(f"{path}: se esperaba una clave 'overrides' con una lista")
    n = 0
    for it in items:
        if not isinstance(it, dict) or "uid" not in it or "action" not in it:
            raise ValueError(f"{path}: override inválido: {it!r}")
        uid = str(it["uid"]).strip()
        if not uid.startswith(("anilist:", "mal:")):
            raise ValueError(f"{path}: uid debe empezar por 'anilist:' o 'mal:' ({uid})")
        db.set_override(
            uid, str(it["action"]), media_type=it.get("media_type"),
            tmdb_id=int(it["tmdb_id"]) if it.get("tmdb_id") else None,
            canonical_uid=it.get("canonical_uid"), note=it.get("note"),
        )
        n += 1
    return n


def export_overrides(db: Database, path: Path) -> int:
    items: list[dict[str, Any]] = []
    for o in db.list_overrides():
        item = {"uid": o["uid"], "action": o["action"]}
        for k in ("media_type", "tmdb_id", "canonical_uid", "note"):
            if o.get(k) is not None:
                item[k] = o[k]
        items.append(item)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump({"overrides": items}, allow_unicode=True, sort_keys=False), encoding="utf-8")
    return len(items)
