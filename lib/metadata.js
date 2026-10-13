/**
 * External metadata used only to identify what the client is asking for.
 * The addon never serves this metadata back (no meta/catalog resources).
 */
const { fetchJson } = require("./http")
const { TTLCache } = require("./cache")
const { isLatinTitle } = require("./titles")

const CINEMETA_BASE = process.env.CINEMETA_BASE || "https://v3-cinemeta.strem.io"
const ANILIST_API = "https://graphql.anilist.co"
const KITSU_API = "https://kitsu.io/api/edge"
const TMDB_API = "https://api.themoviedb.org/3"

const cache = new TTLCache({ ttlMs: 6 * 60 * 60 * 1000 })
exports.cache = cache

const yearOf = (date) => {
  const m = String(date || "").match(/\b(19|20)\d{2}\b/)
  return m ? Number(m[0]) : null
}
exports.yearOf = yearOf

/**
 * Builds { [season]: { count, startYear } } from a list of videos.
 * Season 0 (specials) is kept apart because it never maps to a JKAnime episode.
 */
function seasonLayout(videos) {
  const layout = {}
  for (const v of videos || []) {
    const season = Number(v.season)
    const episode = Number(v.episode ?? v.number)
    if (!Number.isInteger(season) || !Number.isInteger(episode) || episode < 1) continue
    const entry = layout[season] || (layout[season] = { count: 0, startYear: null, maxEpisode: 0 })
    entry.count++
    entry.maxEpisode = Math.max(entry.maxEpisode, episode)
    const y = yearOf(v.released || v.firstAired || v.air_date)
    if (y && (entry.startYear === null || y < entry.startYear)) entry.startYear = y
  }
  return layout
}
exports.seasonLayout = seasonLayout

/** @returns {Promise<{name, year, type, aliases: string[], layout}>} */
exports.getCinemeta = (type, imdbId) => cache.wrap(`cinemeta:${type}:${imdbId}`, async () => {
  const data = await fetchJson(`${CINEMETA_BASE}/meta/${type}/${encodeURIComponent(imdbId)}.json`)
  const meta = data?.meta
  if (!meta?.name) throw new Error(`Cinemeta has no ${type} ${imdbId}`)
  return {
    name: meta.name,
    year: yearOf(meta.releaseInfo || meta.year || meta.released),
    type: meta.type,
    aliases: [],
    tmdbId: meta.moviedb_id,
    layout: seasonLayout(meta.videos),
  }
})

const ANILIST_FIELDS = "id idMal format episodes startDate { year } title { romaji english native } synonyms"

function parseAniList(media) {
  if (!media) return null
  const titles = [media.title?.english, media.title?.romaji, ...(media.synonyms || [])]
    .filter((t) => t && isLatinTitle(t))
  return {
    source: "anilist",
    id: media.id,
    idMal: media.idMal,
    format: media.format,
    episodes: media.episodes,
    startYear: media.startDate?.year || null,
    titles: [...new Set(titles)],
  }
}

async function anilistQuery(query, variables) {
  const data = await fetchJson(ANILIST_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  })
  if (data?.errors?.length) throw new Error(`AniList: ${data.errors[0].message}`)
  return data?.data
}

/** AniList search, used to collect alternative titles (romaji/english/synonyms). */
exports.searchAniList = (search) => cache.wrap(`anilist:search:${search}`, async () => {
  const data = await anilistQuery(
    `query ($s: String) { Page(perPage: 15) { media(search: $s, type: ANIME) { ${ANILIST_FIELDS} } } }`,
    { s: search })
  return (data?.Page?.media || []).map(parseAniList)
})

exports.getAniList = (idType, id) => cache.wrap(`anilist:${idType}:${id}`, async () => {
  const arg = idType === "mal" ? "idMal" : "id"
  const data = await anilistQuery(
    `query ($id: Int) { Media(${arg}: $id, type: ANIME) { ${ANILIST_FIELDS} } }`, { id: Number(id) })
  const parsed = parseAniList(data?.Media)
  if (!parsed) throw new Error(`AniList has no ${idType} ${id}`)
  return parsed
})

exports.getKitsu = (id) => cache.wrap(`kitsu:${id}`, async () => {
  const data = await fetchJson(`${KITSU_API}/anime/${encodeURIComponent(id)}`, {
    headers: { Accept: "application/vnd.api+json" },
  })
  const a = data?.data?.attributes
  if (!a) throw new Error(`Kitsu has no anime ${id}`)
  const titles = [a.titles?.en, a.titles?.en_jp, a.titles?.en_us, a.canonicalTitle, ...(a.abbreviatedTitles || [])]
    .filter((t) => t && isLatinTitle(t))
  const format = { TV: "TV", movie: "MOVIE", OVA: "OVA", ONA: "ONA", special: "SPECIAL", music: "MUSIC" }[a.subtype] || a.subtype
  return { source: "kitsu", id, format, episodes: a.episodeCount, startYear: yearOf(a.startDate), titles: [...new Set(titles)] }
})

const tmdbToken = () => process.env.TMDB_API_READ_TOKEN
exports.hasTmdb = () => Boolean(tmdbToken())

/**
 * TMDB season layout for an IMDb id. Only used with the numbering=tmdb config,
 * for clients whose episode lists come from TMDB (e.g. Black Clover is split in
 * 4 seasons of 51/51/52/16 there, but is a single 170-episode season on Cinemeta).
 */
exports.getTmdbLayout = (imdbId) => cache.wrap(`tmdb:layout:${imdbId}`, async () => {
  if (!tmdbToken()) throw new Error("TMDB_API_READ_TOKEN is not set")
  const headers = { Authorization: `Bearer ${tmdbToken()}` }
  const found = await fetchJson(`${TMDB_API}/find/${encodeURIComponent(imdbId)}?external_source=imdb_id`, { headers })
  const tv = found?.tv_results?.[0]
  if (!tv) throw new Error(`TMDB has no series for ${imdbId}`)
  const show = await fetchJson(`${TMDB_API}/tv/${tv.id}`, { headers })
  const layout = {}
  for (const s of show?.seasons || []) {
    if (!Number.isInteger(s.season_number) || !s.episode_count) continue
    layout[s.season_number] = { count: s.episode_count, maxEpisode: s.episode_count, startYear: yearOf(s.air_date) }
  }
  return layout
})

exports.getImdbFromTmdb = (tmdbId, type) => cache.wrap(`tmdb:imdb:${type}:${tmdbId}`, async () => {
  if (!tmdbToken()) throw new Error("TMDB_API_READ_TOKEN is not set")
  const kind = type === "movie" ? "movie" : "tv"
  const ids = await fetchJson(`${TMDB_API}/${kind}/${encodeURIComponent(tmdbId)}/external_ids`, {
    headers: { Authorization: `Bearer ${tmdbToken()}` },
  })
  if (!ids?.imdb_id) throw new Error(`TMDB ${tmdbId} has no IMDb id`)
  return ids.imdb_id
})
