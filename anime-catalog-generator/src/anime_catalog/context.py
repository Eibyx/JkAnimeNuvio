"""Construcción de clientes y recursos compartidos a partir de la configuración de entorno."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

import httpx

from .config import Settings
from .integrations.mdblist import MDBListClient
from .mapping.index import MappingIndex
from .mapping.updater import MappingUpdater
from .providers.anilist import AniListClient
from .providers.jikan import JikanClient
from .providers.tmdb import TMDBClient
from .storage.cache import Cache
from .storage.database import Database
from .storage.overrides import import_overrides
from .storage.repository import AnimeRepository

log = logging.getLogger(__name__)


@dataclass
class Transports:
    """Transportes HTTP inyectables (pruebas con httpx.MockTransport)."""

    anilist: httpx.BaseTransport | None = None
    jikan: httpx.BaseTransport | None = None
    tmdb: httpx.BaseTransport | None = None
    mdblist: httpx.BaseTransport | None = None
    datasets: httpx.BaseTransport | None = None
    sleep: Any = None


@dataclass
class AppContext:
    settings: Settings
    db: Database
    cache: Cache
    repo: AnimeRepository
    index: MappingIndex
    anilist: AniListClient
    jikan: JikanClient
    updater: MappingUpdater
    tmdb: TMDBClient | None = None
    mdblist: MDBListClient | None = None
    closers: list[Any] = field(default_factory=list)

    def close(self) -> None:
        for c in self.closers:
            try:
                c.close()
            except Exception:  # pragma: no cover
                pass
        self.db.close()


def build_context(settings: Settings, *, transports: Transports | None = None, use_cache: bool = True) -> AppContext:
    t = transports or Transports()
    db = Database(settings.database_path)
    if settings.overrides_path and settings.overrides_path.is_file():
        n = import_overrides(db, settings.overrides_path)
        log.debug("Importados %d overrides desde %s", n, settings.overrides_path)
    cache = Cache(db, enabled=use_cache)
    repo = AnimeRepository(db, use_cache=use_cache)
    anilist = AniListClient(settings.anilist_api_url, repo, cache, transport=t.anilist, timeout=settings.http_timeout, sleep=t.sleep)
    jikan = JikanClient(settings.jikan_api_url, repo, cache, transport=t.jikan, timeout=settings.http_timeout, sleep=t.sleep)
    updater = MappingUpdater(db, settings.datasets_dir, transport=t.datasets, sleep=t.sleep)
    tmdb = None
    if settings.has_tmdb:
        tmdb = TMDBClient(settings.tmdb_api_url, cache, api_key=settings.tmdb_api_key, read_token=settings.tmdb_read_token,
                          transport=t.tmdb, sleep=t.sleep)
    mdb = None
    if settings.mdblist_api_key:
        mdb = MDBListClient(settings.mdblist_api_key, settings.mdblist_api_url, transport=t.mdblist, sleep=t.sleep)
    ctx = AppContext(settings=settings, db=db, cache=cache, repo=repo, index=MappingIndex(db), anilist=anilist, jikan=jikan,
                     updater=updater, tmdb=tmdb, mdblist=mdb)
    ctx.closers = [x for x in (anilist, jikan, updater, tmdb, mdb) if x is not None]
    return ctx
