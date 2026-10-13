/**
 * Id correspondences from community relation databases. They are CLAIMS:
 * the identity module only accepts one when another source confirms it.
 * - yuna (relations.yuna.moe): anilist/mal/kitsu/anidb -> imdb, tmdb, tvdb, ...
 * - ani.zip: anilist/mal/kitsu/anidb/themoviedb/thetvdb -> the other ids
 * Neither supports a reverse lookup from an IMDb id.
 */
const { fetchJson } = require("../utils/http")
const { mappingCache, timeoutFor, log } = require("./common")

const YUNA = "https://relations.yuna.moe/api/v2/ids"
const ANIZIP = "https://api.ani.zip/mappings"
const timeout = () => timeoutFor("RELATIONS_TIMEOUT_MS", 6000)
const str = (v) => (v === null || v === undefined || v === "" ? null : String(v))

exports.name = "relations"
exports.enabled = () => (process.env.RELATIONS_ENABLED || "").toLowerCase() !== "false"

const YUNA_SOURCE = { anilist: "anilist", mal: "myanimelist", kitsu: "kitsu", anidb: "anidb" }
const ANIZIP_SOURCE = { anilist: "anilist_id", mal: "mal_id", kitsu: "kitsu_id", anidb: "anidb_id", tmdb: "themoviedb_id", tvdb: "thetvdb_id" }

async function yuna(source, id) {
  if (!YUNA_SOURCE[source]) return null
  const d = await fetchJson(`${YUNA}?source=${YUNA_SOURCE[source]}&id=${encodeURIComponent(id)}&include=anilist,myanimelist,kitsu,anidb,imdb,themoviedb,thetvdb`, { timeout: timeout() })
  if (!d || typeof d !== "object") return null
  return { anilist: str(d.anilist), mal: str(d.myanimelist), kitsu: str(d.kitsu), imdb: str(d.imdb), tmdb: str(d.themoviedb), tvdb: str(d.thetvdb) }
}

async function anizip(source, id) {
  if (!ANIZIP_SOURCE[source]) return null
  const d = await fetchJson(`${ANIZIP}?${ANIZIP_SOURCE[source]}=${encodeURIComponent(id)}`, { timeout: timeout() })
  const m = d?.mappings
  if (!m) return null
  return {
    anilist: str(m.anilist_id), mal: str(m.mal_id), kitsu: str(m.kitsu_id), imdb: str(m.imdb_id), tmdb: str(m.themoviedb_id), tvdb: str(m.thetvdb_id),
    // ani.zip also lists the entry's titles (e.g. x-jat "Ao Ashi S2").
    titles: Object.values(d.titles || {}).filter((t) => typeof t === "string" && t.trim()),
  }
}

/**
 * All claims about an id, per database: [{ db: "yuna"|"anizip", ids }]
 * (ani.zip's ids also carry `titles`).
 * A database that is down or has no entry simply contributes nothing.
 */
exports.lookup = (source, id) => mappingCache.wrap(`relations:${source}:${id}`, async () => {
  if (!exports.enabled()) return []
  const settled = await Promise.allSettled([yuna(source, id), anizip(source, id)])
  const out = []
  settled.forEach((r, i) => {
    const db = i === 0 ? "yuna" : "anizip"
    if (r.status === "fulfilled" && r.value) out.push({ db, ids: r.value })
    else if (r.status === "rejected" && r.reason?.status !== 404 && r.reason?.status !== 400) log(`${db} ${source}:${id} failed: ${r.reason?.message}`)
  })
  return out
})
