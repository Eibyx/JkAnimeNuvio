"""Persistencia de entradas de anime y relaciones con caducidad según el estado de emisión."""

from __future__ import annotations

import json
import time

from ..models import AnimeEntry
from .cache import DAY
from .database import Database

# Los animes finalizados cambian poco; los que están en emisión o por estrenarse, a menudo.
TTL_BY_STATUS = {
    "FINISHED": 30 * DAY,
    "CANCELLED": 30 * DAY,
    "RELEASING": 1 * DAY,
    "NOT_YET_RELEASED": 1 * DAY,
    "HIATUS": 7 * DAY,
}


class AnimeRepository:
    def __init__(self, db: Database, use_cache: bool = True):
        self.db = db
        self.use_cache = use_cache

    def save(self, entries: list[AnimeEntry]) -> None:
        now = time.time()
        with self.db.transaction() as conn:
            for e in entries:
                conn.execute(
                    """INSERT INTO anime(uid, provider, anilist_id, mal_id, title, format, status, start_year,
                       start_date, average_score, data, fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(uid) DO UPDATE SET provider=excluded.provider, anilist_id=excluded.anilist_id,
                       mal_id=excluded.mal_id, title=excluded.title, format=excluded.format, status=excluded.status,
                       start_year=excluded.start_year, start_date=excluded.start_date,
                       average_score=excluded.average_score, data=excluded.data, fetched_at=excluded.fetched_at""",
                    (
                        e.uid, e.provider, e.anilist_id, e.mal_id, e.title, e.format, e.status,
                        e.start_date.year, e.start_date.to_int(), e.average_score,
                        e.model_dump_json(), now,
                    ),
                )
                conn.execute("DELETE FROM relations WHERE src_uid=?", (e.uid,))
                conn.executemany(
                    "INSERT OR IGNORE INTO relations(src_uid, dst_uid, relation_type) VALUES(?,?,?)",
                    [(e.uid, r.target_uid, r.relation_type) for r in e.relations if r.target_type == "ANIME"],
                )

    def _fresh(self, data: str, fetched_at: float) -> AnimeEntry | None:
        entry = AnimeEntry.model_validate_json(data)
        ttl = TTL_BY_STATUS.get(entry.status or "", 7 * DAY)
        if not self.use_cache or fetched_at + ttl < time.time():
            return None
        return entry

    def get(self, uid: str, allow_stale: bool = False) -> AnimeEntry | None:
        row = self.db.conn.execute("SELECT data, fetched_at FROM anime WHERE uid=?", (uid,)).fetchone()
        if not row:
            return None
        if allow_stale:
            return AnimeEntry.model_validate_json(row["data"])
        return self._fresh(row["data"], row["fetched_at"])

    def get_many(self, uids: list[str], allow_stale: bool = False) -> dict[str, AnimeEntry]:
        out: dict[str, AnimeEntry] = {}
        for i in range(0, len(uids), 500):
            chunk = uids[i : i + 500]
            q = ",".join("?" * len(chunk))
            for row in self.db.conn.execute(f"SELECT uid, data, fetched_at FROM anime WHERE uid IN ({q})", chunk):
                e = AnimeEntry.model_validate_json(row["data"]) if allow_stale else self._fresh(row["data"], row["fetched_at"])
                if e is not None:
                    out[row["uid"]] = e
        return out

    def save_canonical(self, canonical_uid: str, original_year: int | None, members: list[str], criteria: list[str]) -> None:
        self.db.conn.execute(
            """INSERT INTO canonical(canonical_uid, original_year, members, criteria, updated_at) VALUES(?,?,?,?,?)
               ON CONFLICT(canonical_uid) DO UPDATE SET original_year=excluded.original_year,
               members=excluded.members, criteria=excluded.criteria, updated_at=excluded.updated_at""",
            (canonical_uid, original_year, json.dumps(members), json.dumps(criteria, ensure_ascii=False), time.time()),
        )
