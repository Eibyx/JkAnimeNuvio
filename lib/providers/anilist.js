/** AniList: romaji/english titles, synonyms, AniList/MAL ids, year/season and format. */
const { fetchJson } = require("../http")
const { isLatinTitle } = require("../titles")
const { cache, limiter, timeoutFor } = require("./common")

const API = "https://graphql.anilist.co"
const FIELDS = "id idMal format episodes season seasonYear startDate { year } title { romaji english native } synonyms"
// AniList allows ~90 requests/min; keep few in flight.
const limit = limiter(2)

exports.name = "anilist"

function parse(media) {
  if (!media) return null
  const titles = [media.title?.english, media.title?.romaji, ...(media.synonyms || [])].filter((t) => t && isLatinTitle(t))
  return {
    source: "anilist",
    id: media.id,
    idMal: media.idMal,
    format: media.format,
    episodes: media.episodes,
    season: media.season || null,
    startYear: media.startDate?.year || media.seasonYear || null,
    native: media.title?.native || null,
    titles: [...new Set(titles)],
  }
}
exports.parse = parse

async function query(q, variables) {
  const data = await limit(() => fetchJson(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: q, variables }),
    timeout: timeoutFor("ANILIST_TIMEOUT_MS", 8000),
  }))
  if (data?.errors?.length) throw new Error(`AniList: ${data.errors[0].message}`)
  return data?.data
}

/** Title search (latin or Japanese). */
exports.search = (text) => cache.wrap(`anilist:search:${text}`, async () => {
  const data = await query(`query ($s: String) { Page(perPage: 15) { media(search: $s, type: ANIME) { ${FIELDS} } } }`, { s: text })
  return (data?.Page?.media || []).map(parse)
})

/** Lookup by AniList ("anilist") or MyAnimeList ("mal") id. */
exports.getById = (idType, id) => cache.wrap(`anilist:${idType}:${id}`, async () => {
  const arg = idType === "mal" ? "idMal" : "id"
  const data = await query(`query ($id: Int) { Media(${arg}: $id, type: ANIME) { ${FIELDS} } }`, { id: Number(id) })
  const parsed = parse(data?.Media)
  if (!parsed) throw new Error(`AniList has no ${idType} ${id}`)
  return parsed
})
