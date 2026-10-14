"""CanonicalAnimeResolver: agrupa temporadas/partes de un mismo programa televisivo y elige su
entrada original (la serie canónica que se envía a MDBList).

Algoritmo:
1. Partir de las entradas encontradas (semillas).
2. Recorrer relaciones PREQUEL hacia atrás para cargar temporadas anteriores (sin descargar las que
   los mappings ya indican que pertenecen a otra serie de TMDB).
3. Completar con el índice inverso de mappings: entradas que apuntan a la misma serie de TMDB
   (típicamente la temporada 1), aunque la cadena de relaciones esté rota.
4. Unir entradas con relación PREQUEL/SEQUEL solo si respaldan la MISMA serie externa (TMDB, o TVDB
   en su defecto). Una secuela sin mapping se une al grupo, pero nunca puede unir dos series distintas.
5. Unir grupos que apuntan al mismo TMDB TV ID (misma entidad para MDBList).
6. Elegir como canónica la entrada de emisión (TV/TV_SHORT/ONA) con fecha de estreno más temprana.

No se agrupa por nombres ni por franquicia: spin-offs, remakes, películas y series del mismo universo
quedan separados salvo que los mappings indiquen el mismo programa de TMDB.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field

from ..config import CanonicalConfig
from ..mapping.index import DATASET_CLASSES, MappingIndex, season_of
from ..models import BROADCAST_FORMATS, SERIES_FORMATS, AnimeEntry
from ..storage.database import Database

log = logging.getLogger(__name__)

Fetcher = Callable[[list[str]], dict[str, AnimeEntry]]


@dataclass
class CanonicalGroup:
    root: AnimeEntry
    members: dict[str, AnimeEntry]
    criteria: list[str] = field(default_factory=list)
    show_ids: set[int] = field(default_factory=set)
    kind: str = "series"  # series | movie | other

    @property
    def uid(self) -> str:
        return self.root.uid

    def member_list(self) -> list[AnimeEntry]:
        return sorted(self.members.values(), key=lambda e: (e.start_date.sort_key(), e.anilist_id or e.mal_id or 0))


class _UnionFind:
    def __init__(self) -> None:
        self.parent: dict[str, str] = {}
        self.shows: dict[str, set[int]] = {}
        self.tvdb: dict[str, set[int]] = {}

    def add(self, uid: str, shows: set[int], tvdb: set[int]) -> None:
        if uid not in self.parent:
            self.parent[uid] = uid
            self.shows[uid] = set(shows)
            self.tvdb[uid] = set(tvdb)

    def find(self, uid: str) -> str:
        while self.parent[uid] != uid:
            self.parent[uid] = self.parent[self.parent[uid]]
            uid = self.parent[uid]
        return uid

    def compatible(self, a: str, b: str) -> bool:
        """Dos grupos solo se unen si sus series TMDB no se contradicen (vacío o subconjunto)."""
        sa, sb = self.shows[self.find(a)], self.shows[self.find(b)]
        return not sa or not sb or sa <= sb or sb <= sa

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        self.parent[rb] = ra
        self.shows[ra] |= self.shows.pop(rb)
        self.tvdb[ra] |= self.tvdb.pop(rb)


class CanonicalAnimeResolver:
    def __init__(
        self,
        index: MappingIndex,
        config: CanonicalConfig,
        fetcher: Fetcher,
        *,
        db: Database | None = None,
        source_order: list[str] | None = None,
    ):
        self.index = index
        self.config = config
        self.fetch = fetcher
        self.db = db
        self.sources = [s for s in (source_order or list(DATASET_CLASSES)) if s in DATASET_CLASSES]
        self._shows: dict[str, set[int]] = {}
        self._tvdb: dict[str, set[int]] = {}
        self.fetched_extra = 0
        self.notes: list[str] = []

    # ------------------------------------------------------------------ mappings por entrada
    def _idents(self, e: AnimeEntry) -> list[tuple[str, int]]:
        out = []
        if e.anilist_id:
            out.append(("anilist", e.anilist_id))
        if e.mal_id:
            out.append(("mal", e.mal_id))
        return out

    def primary_shows(self, e: AnimeEntry) -> set[int]:
        """Series de TMDB según la fuente de mayor prioridad que tenga datos (directo > inverso)."""
        if e.uid in self._shows:
            return self._shows[e.uid]
        result: set[int] = set()
        for src in self.sources:
            direct: set[int] = set()
            reverse: set[int] = set()
            for p, i in self._idents(e):
                for h in self.index.forward(p, i, [src]):
                    if h.dst_provider == "tmdb_show" and h.dst_id.isdigit():
                        direct.add(int(h.dst_id))
                for h in self.index.reverse(p, i, [src]):
                    if h.src_provider == "tmdb_show" and h.src_id.isdigit():
                        reverse.add(int(h.src_id))
            if direct or reverse:
                result = direct or reverse
                break
        self._shows[e.uid] = result
        return result

    def primary_seasons(self, e: AnimeEntry, show: int) -> set[int]:
        seasons: set[int] = set()
        for p, i in self._idents(e):
            for h in self.index.forward(p, i, self.sources):
                if h.dst_provider == "tmdb_show" and h.dst_id == str(show):
                    s = season_of(h.dst_scope)
                    if s is not None:
                        seasons.add(s)
        return seasons

    def tvdb_shows(self, e: AnimeEntry) -> set[int]:
        if e.uid not in self._tvdb:
            out: set[int] = set()
            for p, i in self._idents(e):
                for h in self.index.forward(p, i, self.sources):
                    if h.dst_provider == "tvdb_show" and h.dst_id.isdigit():
                        out.add(int(h.dst_id))
            self._tvdb[e.uid] = out
        return self._tvdb[e.uid]

    # ------------------------------------------------------------------ carga del grafo
    def _expand(self, loaded: dict[str, AnimeEntry]) -> None:
        frontier = [e for e in loaded.values() if e.format in SERIES_FORMATS]
        for _ in range(self.config.max_prequel_depth):
            wanted: list[str] = []
            for e in frontier:
                my_shows = self.primary_shows(e)
                for r in e.relations_of("PREQUEL"):
                    if r.target_uid in loaded or r.target_uid in wanted:
                        continue
                    if r.target_format and r.target_format not in SERIES_FORMATS:
                        continue
                    # Evitar descargas inútiles: si los mappings ya dicen que es otra serie, no se sigue.
                    target_shows = self._shows_for_uid(r.target_uid)
                    if my_shows and target_shows and not (my_shows & target_shows):
                        continue
                    wanted.append(r.target_uid)
            if not wanted:
                break
            got = self.fetch(wanted)
            self.fetched_extra += len(got)
            new = [g for uid, g in got.items() if uid not in loaded]
            loaded.update(got)
            frontier = [g for g in new if g.format in SERIES_FORMATS]
            if not frontier:
                break

    def _shows_for_uid(self, uid: str) -> set[int]:
        provider, _, ident = uid.partition(":")
        if not ident.isdigit():
            return set()
        fake = AnimeEntry(provider="anilist" if provider == "anilist" else "myanimelist",
                          anilist_id=int(ident) if provider == "anilist" else None,
                          mal_id=int(ident) if provider == "mal" else None)
        return self.primary_shows(fake)

    def _complete_shows(self, loaded: dict[str, AnimeEntry]) -> None:
        """Carga la(s) entrada(s) de la temporada más baja de cada serie TMDB presente (índice inverso)."""
        if not self.config.complete_shows_from_mappings:
            return
        provider = "anilist" if any(e.provider == "anilist" for e in loaded.values()) else "mal"
        wanted: set[str] = set()
        for e in list(loaded.values()):
            if e.format not in BROADCAST_FORMATS:
                continue
            for show in self.primary_shows(e):
                rows = [r for r in self.index.anime_ids_for_show(show) if r[0] == provider and r[3] in self.sources]
                regular = [r for r in rows if r[2] is not None and r[2] >= 1]
                if not regular:
                    continue
                lowest = min(r[2] for r in regular)  # type: ignore[type-var]
                for prov, ident, season, _src in regular:
                    if season == lowest:
                        uid = f"{prov}:{ident}"
                        if uid not in loaded:
                            wanted.add(uid)
        if wanted:
            got = self.fetch(sorted(wanted))
            self.fetched_extra += len(got)
            loaded.update(got)

    # ------------------------------------------------------------------ agrupación
    def resolve(self, seeds: dict[str, AnimeEntry]) -> list[CanonicalGroup]:
        loaded = dict(seeds)
        if self.config.collapse_seasons:
            self._expand(loaded)
            self._complete_shows(loaded)
            # Las entradas añadidas en la compleción también pueden tener precuelas.
            self._expand(loaded)

        uf = _UnionFind()
        reasons: dict[str, list[str]] = {}
        series = {u: e for u, e in loaded.items() if e.format in SERIES_FORMATS or e.format is None}
        movies = {u: e for u, e in loaded.items() if e.format == "MOVIE"}
        others = {u: e for u, e in loaded.items() if u not in series and u not in movies}
        for uid, e in series.items():
            uf.add(uid, self.primary_shows(e), self.tvdb_shows(e))

        def note(a: str, b: str, why: str) -> None:
            reasons.setdefault(a, []).append(why)
            reasons.setdefault(b, []).append(why)

        if self.config.collapse_seasons:
            # Paso 4: relaciones PREQUEL/SEQUEL + misma serie externa.
            for uid, e in sorted(series.items()):
                for r in e.relations_of("PREQUEL", "SEQUEL"):
                    if r.target_uid not in series or uf.find(uid) == uf.find(r.target_uid):
                        continue
                    a_sh, b_sh = self.primary_shows(e), self.primary_shows(series[r.target_uid])
                    common = a_sh & b_sh
                    if common:
                        if not uf.compatible(uid, r.target_uid):
                            continue
                        uf.union(uid, r.target_uid)
                        note(uid, r.target_uid, f"{r.relation_type} {uid}~{r.target_uid}: misma serie TMDB {sorted(common)}")
                    elif a_sh and b_sh:
                        note(uid, r.target_uid, f"{r.relation_type} {uid}~{r.target_uid}: series TMDB distintas {sorted(a_sh)} / {sorted(b_sh)} (no se agrupan)")
                    elif not a_sh and not b_sh:
                        ta, tb = self.tvdb_shows(e), self.tvdb_shows(series[r.target_uid])
                        if ta & tb:
                            uf.union(uid, r.target_uid)
                            note(uid, r.target_uid, f"{r.relation_type} {uid}~{r.target_uid}: misma serie TVDB {sorted(ta & tb)}")
                        elif self.config.merge_unmapped_sequels and not (ta and tb) and _continuation(e, series[r.target_uid], r.relation_type):
                            uf.union(uid, r.target_uid)
                            note(uid, r.target_uid, f"{r.relation_type} {uid}~{r.target_uid}: continuación sin mapping externo; se agrupa por la relación")
                    elif self.config.merge_unmapped_sequels:
                        # Solo se agrega una CONTINUACIÓN (secuela posterior, formato de emisión) sin mapping
                        # propio, y nunca si con ello se unirían dos series distintas.
                        unmapped_is_sequel = _continuation(e, series[r.target_uid], r.relation_type, unmapped_first=not a_sh)
                        if unmapped_is_sequel and uf.compatible(uid, r.target_uid):
                            uf.union(uid, r.target_uid)
                            note(uid, r.target_uid, f"{r.relation_type} {uid}~{r.target_uid}: secuela sin mapping propio; se agrupa con la serie {sorted(a_sh or b_sh)}")
                        else:
                            note(uid, r.target_uid, f"{r.relation_type} {uid}~{r.target_uid}: entrada sin mapping que no es una continuación; no se agrupa")

            # Paso 5: mismo TMDB TV ID => misma entidad, aunque falte la relación.
            by_show: dict[int, list[str]] = {}
            for uid in series:
                sh = self.primary_shows(series[uid])
                if len(sh) == 1:
                    by_show.setdefault(next(iter(sh)), []).append(uid)
            for show, uids in by_show.items():
                for other in uids[1:]:
                    if uf.find(uids[0]) != uf.find(other):
                        if uf.compatible(uids[0], other):
                            uf.union(uids[0], other)
                            note(uids[0], other, f"{uids[0]}~{other}: mismo TMDB TV ID {show}")

        # Overrides de canonicidad (persisten en la base de datos).
        if self.db is not None:
            for ov in self.db.list_overrides():
                if ov["action"] == "canonical" and ov["uid"] in series and ov["canonical_uid"] in series:
                    uf.union(ov["canonical_uid"], ov["uid"])
                    note(ov["uid"], ov["canonical_uid"], f"override manual: {ov['uid']} pertenece a {ov['canonical_uid']}")

        groups: dict[str, dict[str, AnimeEntry]] = {}
        for uid in series:
            groups.setdefault(uf.find(uid), {})[uid] = series[uid]

        out: list[CanonicalGroup] = []
        for members in groups.values():
            root = choose_root(list(members.values()))
            crit = sorted({r for u in members for r in reasons.get(u, [])})
            shows = set().union(*(self.primary_shows(m) for m in members.values()))
            if len(members) == 1:
                crit = crit or ["entrada única (sin temporadas relacionadas de la misma serie)"]
            out.append(CanonicalGroup(root=root, members=members, criteria=crit, show_ids=shows, kind="series"))

        for uid, e in movies.items():
            out.append(CanonicalGroup(root=e, members={uid: e}, criteria=["película independiente (no se agrupa con series)"], kind="movie"))
        for uid, e in others.items():
            out.append(CanonicalGroup(root=e, members={uid: e}, criteria=[f"formato {e.format}: entrada independiente"], kind="other"))
        return out


def _continuation(a: AnimeEntry, b: AnimeEntry, relation: str, unmapped_first: bool | None = None) -> bool:
    """¿La relación a->b describe una continuación (secuela posterior) entre formatos de emisión?

    `relation` es el tipo de la arista vista desde `a`. Si `unmapped_first` es True/False, se exige
    además que la entrada SIN mapping (a o b, respectivamente) sea la secuela.
    """
    if a.format not in BROADCAST_FORMATS or b.format not in BROADCAST_FORMATS:
        return False
    if relation == "PREQUEL":  # b es precuela de a => a es la secuela
        sequel, prequel = a, b
    elif relation == "SEQUEL":  # b es secuela de a
        sequel, prequel = b, a
    else:
        return False
    if unmapped_first is True and sequel is not a:
        return False
    if unmapped_first is False and sequel is not b:
        return False
    if sequel.start_date.known and prequel.start_date.known and sequel.start_date.sort_key() < prequel.start_date.sort_key():
        return False
    return True


def choose_root(members: list[AnimeEntry]) -> AnimeEntry:
    """Entrada original: emisión (TV/TV_SHORT/ONA) con estreno más temprano; desempate por ID."""
    broadcast = [m for m in members if m.format in BROADCAST_FORMATS and m.start_date.known]
    pool = broadcast or [m for m in members if m.start_date.known] or members
    fmt_rank = {"TV": 0, "ONA": 1, "TV_SHORT": 2}
    return min(pool, key=lambda m: (m.start_date.sort_key(), fmt_rank.get(m.format or "", 9), m.anilist_id or m.mal_id or 0))
