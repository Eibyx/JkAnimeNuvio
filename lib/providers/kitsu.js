/** Kitsu (auxiliary): titles for kitsu: ids and Kitsu's own id mappings. */
const { fetchJson } = require("../http")
const { isLatinTitle } = require("../titles")
const { cache, mappingCache, yearOf, timeoutFor } = require("./common")

const API = "https://kitsu.io/api/edge"
const opts = () => ({ headers: { Accept: "application/vnd.api+json" }, timeout: timeoutFor("KITSU_TIMEOUT_MS", 8000) })

exports.name = "kitsu"

exports.getById = (id) => cache.wrap(`kitsu:${id}`, async () => {
  const data = await fetchJson(`${API}/anime/${encodeURIComponent(id)}`, opts())
  const a = data?.data?.attributes
  if (!a) throw new Error(`Kitsu has no anime ${id}`)
  const titles = [a.titles?.en, a.titles?.en_jp, a.titles?.en_us, a.canonicalTitle, ...(a.abbreviatedTitles || [])]
    .filter((t) => t && isLatinTitle(t))
  const format = { TV: "TV", movie: "MOVIE", OVA: "OVA", ONA: "ONA", special: "SPECIAL", music: "MUSIC" }[a.subtype] || a.subtype
  return { source: "kitsu", id: String(id), format, episodes: a.episodeCount, startYear: yearOf(a.startDate), titles: [...new Set(titles)] }
})

/** Kitsu's recorded external ids, e.g. { anilist: "187316", mal: "61140", tvdb: ... }. */
exports.getMappings = (id) => mappingCache.wrap(`kitsu:mappings:${id}`, async () => {
  const data = await fetchJson(`${API}/anime/${encodeURIComponent(id)}/mappings`, opts())
  const out = {}
  const key = { "anilist/anime": "anilist", "myanimelist/anime": "mal", thetvdb: "tvdb", "thetvdb/series": "tvdb", anidb: "anidb" }
  for (const m of data?.data || []) {
    const k = key[m?.attributes?.externalSite]
    if (k && m.attributes.externalId) out[k] = String(m.attributes.externalId)
  }
  return out
})
