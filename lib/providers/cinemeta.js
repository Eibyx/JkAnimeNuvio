/** Cinemeta (optional): name, year and its own season layout for IMDb ids. */
const { fetchJson } = require("../http")
const { cache, yearOf, seasonLayout, env, timeoutFor } = require("./common")

const BASE = () => env("CINEMETA_BASE") || "https://v3-cinemeta.strem.io"

exports.name = "cinemeta"
exports.enabled = () => env("CINEMETA_ENABLED").toLowerCase() !== "false"

/**
 * @returns {Promise<Identity|null>} null when Cinemeta does not know the id
 * (it answers `{}` for recent shows, e.g. tt42938834).
 */
exports.getByImdb = (type, imdbId) => cache.wrap(`cinemeta:${type}:${imdbId}`, async () => {
  const data = await fetchJson(`${BASE()}/meta/${type}/${encodeURIComponent(imdbId)}.json`,
    { timeout: timeoutFor("CINEMETA_TIMEOUT_MS", 8000) })
  const meta = data?.meta
  if (!meta?.name) return null
  return {
    provider: "cinemeta",
    type: meta.type === "movie" ? "movie" : "series",
    name: meta.name,
    originalName: null,
    aliases: [],
    year: yearOf(meta.releaseInfo || meta.year || meta.released),
    layout: seasonLayout(meta.videos),
    ids: {
      imdb: imdbId,
      tmdb: meta.moviedb_id ? String(meta.moviedb_id) : null,
      tvdb: meta.tvdb_id ? String(meta.tvdb_id) : null,
    },
  }
})
