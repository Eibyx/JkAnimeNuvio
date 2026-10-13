/**
 * Shared helpers for metadata providers. Providers are only used to identify
 * what the client asks for; the addon never serves their metadata back.
 */
const { TTLCache } = require("../utils/cache")

// Metadata (titles, layouts) and id correspondences change rarely.
const cache = new TTLCache({ ttlMs: 6 * 60 * 60 * 1000, maxEntries: 2000 })
const mappingCache = new TTLCache({ ttlMs: 24 * 60 * 60 * 1000, maxEntries: 5000 })

const yearOf = (date) => {
  const m = String(date || "").match(/\b(19|20)\d{2}\b/)
  return m ? Number(m[0]) : null
}

/**
 * Builds { [season]: { count, maxEpisode, startYear } } from episodes with
 * season/episode numbers. Season 0 (specials) is kept apart because it never
 * maps to a JKAnime episode.
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
    const y = yearOf(v.released || v.firstAired || v.air_date || v.aired)
    if (y && (entry.startYear === null || y < entry.startYear)) entry.startYear = y
  }
  return layout
}

/** Runs at most `max` calls at once (per provider), so API rate limits are respected. */
function limiter(max) {
  let active = 0
  const queue = []
  const next = () => {
    if (active >= max || queue.length === 0) return
    active++
    const { fn, resolve, reject } = queue.shift()
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next() })
  }
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next() })
}

const env = (name) => (process.env[name] || "").trim()
const timeoutFor = (name, fallback) => Number(process.env[name]) || fallback

const log = (...args) => { if (process.env.NODE_ENV !== "test") console.warn("[metadata]", ...args) }

module.exports = { cache, mappingCache, yearOf, seasonLayout, limiter, env, timeoutFor, log }
