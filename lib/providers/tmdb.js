/**
 * TMDB (primary identity provider). Auth: TMDB_API_READ_TOKEN (Bearer),
 * or TMDB_API_KEY (v3 key as query parameter, redacted from errors/logs).
 */
const { fetchJson } = require("../utils/http")
const { isLatinTitle } = require("../identification/titles")
const { cache, mappingCache, yearOf, limiter, env, timeoutFor } = require("./common")

const API = "https://api.themoviedb.org/3"
const limit = limiter(8)

exports.name = "tmdb"
exports.enabled = () => Boolean(env("TMDB_API_READ_TOKEN") || env("TMDB_API_KEY"))

function get(path, params = {}) {
  const token = env("TMDB_API_READ_TOKEN")
  const key = env("TMDB_API_KEY")
  if (!token && !key) throw new Error("TMDB is not configured")
  const url = new URL(API + path)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  if (!token) url.searchParams.set("api_key", key)
  return limit(() => fetchJson(url.href, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    timeout: timeoutFor("TMDB_TIMEOUT_MS", 8000),
  }))
}

/** IMDb id -> TMDB ids, as TMDB itself records it (/find). */
exports.findByImdb = (imdbId) => mappingCache.wrap(`tmdb:find:${imdbId}`, async () => {
  const data = await get(`/find/${encodeURIComponent(imdbId)}`, { external_source: "imdb_id" })
  return {
    tv: (data?.tv_results || []).map((r) => String(r.id)),
    movie: (data?.movie_results || []).map((r) => String(r.id)),
  }
})

function titlesOf(data) {
  const alt = (data?.alternative_titles?.results || data?.alternative_titles?.titles || []).map((t) => t.title)
  const translated = (data?.translations?.translations || []).map((t) => t?.data?.name || t?.data?.title)
  return [...new Set([...alt, ...translated].filter((t) => t && isLatinTitle(t)))]
}

/** Series details: names, alternative/translated titles, seasons, external ids. */
exports.getTv = (tmdbId) => cache.wrap(`tmdb:tv:${tmdbId}`, async () => {
  const d = await get(`/tv/${encodeURIComponent(tmdbId)}`, { append_to_response: "alternative_titles,external_ids,translations" })
  const layout = {}
  for (const s of d?.seasons || []) {
    if (!Number.isInteger(s.season_number) || !s.episode_count) continue
    layout[s.season_number] = { count: s.episode_count, maxEpisode: s.episode_count, startYear: yearOf(s.air_date) }
  }
  return {
    provider: "tmdb",
    type: "series",
    name: d?.name || null,
    originalName: d?.original_name || null,
    aliases: titlesOf(d),
    year: yearOf(d?.first_air_date),
    layout,
    isAnimation: (d?.genres || []).some((g) => g.id === 16),
    originalLanguage: d?.original_language || null,
    ids: {
      tmdb: String(d?.id ?? tmdbId),
      imdb: d?.external_ids?.imdb_id || null,
      tvdb: d?.external_ids?.tvdb_id ? String(d.external_ids.tvdb_id) : null,
    },
  }
})

exports.getMovie = (tmdbId) => cache.wrap(`tmdb:movie:${tmdbId}`, async () => {
  const d = await get(`/movie/${encodeURIComponent(tmdbId)}`, { append_to_response: "alternative_titles,external_ids,translations" })
  return {
    provider: "tmdb",
    type: "movie",
    name: d?.title || null,
    originalName: d?.original_title || null,
    aliases: titlesOf(d),
    year: yearOf(d?.release_date),
    layout: {},
    ids: { tmdb: String(d?.id ?? tmdbId), imdb: d?.imdb_id || d?.external_ids?.imdb_id || null, tvdb: null },
  }
})
