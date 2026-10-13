/**
 * TheTVDB API v4 (fallback identity provider and alternative episode orders).
 * Auth: TVDB_API_KEY (+ optional TVDB_SUBSCRIBER_PIN) -> session token, which
 * is reused, refreshed after 24 h and renewed once on a 401.
 */
const { request, fetchJson, HttpError } = require("../utils/http")
const { isLatinTitle } = require("../identification/titles")
const { cache, mappingCache, yearOf, seasonLayout, limiter, env, timeoutFor } = require("./common")

const API = "https://api4.thetvdb.com/v4"
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000
const ORDERS = ["default", "official", "dvd", "absolute", "alternate", "regional"]
const limit = limiter(4)

exports.name = "tvdb"
exports.ORDERS = ORDERS
exports.enabled = () => Boolean(env("TVDB_API_KEY"))

let session = null // { promise, expires }
exports.resetSession = () => { session = null }

async function login() {
  const apikey = env("TVDB_API_KEY")
  if (!apikey) throw new Error("TVDB is not configured")
  const pin = env("TVDB_SUBSCRIBER_PIN")
  let data
  try {
    const { text } = await request(`${API}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(pin ? { apikey, pin } : { apikey }),
      timeout: timeoutFor("TVDB_TIMEOUT_MS", 8000),
    })
    data = JSON.parse(text)
  } catch (err) {
    // Never echo the request body (it contains the key).
    throw new HttpError(`TVDB login failed (${err.status || err.name})`, err.status || 0, `${API}/login`)
  }
  const token = data?.data?.token
  if (!token) throw new Error("TVDB login returned no token")
  return token
}

function token(force = false) {
  if (force || !session || session.expires < Date.now()) {
    const promise = login()
    session = { promise, expires: Date.now() + TOKEN_TTL_MS }
    promise.catch(() => { if (session?.promise === promise) session = null })
  }
  return session.promise
}

async function get(path) {
  return limit(async () => {
    const call = async (t) => fetchJson(API + path, {
      headers: { Authorization: `Bearer ${t}` },
      timeout: timeoutFor("TVDB_TIMEOUT_MS", 8000),
    })
    try {
      return await call(await token())
    } catch (err) {
      if (err.status !== 401) throw err
      return call(await token(true)) // expired/revoked token: renew once
    }
  })
}

/** IMDb id -> TVDB ids, as TVDB records it (remote id search). */
exports.findByImdb = (imdbId) => mappingCache.wrap(`tvdb:find:${imdbId}`, async () => {
  const data = await get(`/search/remoteid/${encodeURIComponent(imdbId)}`)
  const rows = Array.isArray(data?.data) ? data.data : []
  return {
    series: rows.map((r) => r?.series?.id).filter(Boolean).map(String),
    movie: rows.map((r) => r?.movie?.id).filter(Boolean).map(String),
  }
})

function latinNames(d) {
  const names = [
    ...(d?.aliases || []).map((a) => (typeof a === "string" ? a : a?.name)),
    ...(d?.translations?.nameTranslations || []).map((t) => t?.name),
    ...(d?.translations?.nameTranslations || []).flatMap((t) => t?.aliases || []),
  ]
  return [...new Set(names.filter((n) => n && isLatinTitle(n)))]
}

function remoteId(d, source) {
  const hit = (d?.remoteIds || []).find((r) => String(r?.sourceName || "").toLowerCase().includes(source))
  return hit?.id ? String(hit.id) : null
}

/** Series: name, aliases/translations, year, remote ids, available episode orders. */
exports.getSeries = (tvdbId) => cache.wrap(`tvdb:series:${tvdbId}`, async () => {
  const d = (await get(`/series/${encodeURIComponent(tvdbId)}/extended?meta=translations&short=true`))?.data
  if (!d) throw new Error(`TVDB has no series ${tvdbId}`)
  const eng = (d.translations?.nameTranslations || []).find((t) => t.language === "eng")?.name
  const name = [eng, d.name, ...latinNames(d)].find((n) => n && isLatinTitle(n)) || d.name
  return {
    provider: "tvdb",
    type: "series",
    name,
    originalName: d.name || null,
    aliases: latinNames(d),
    year: Number(d.year) || yearOf(d.firstAired),
    layout: null, // loaded per episode order on demand (getLayout)
    orders: [...new Set((d.seasons || []).map((s) => s?.type?.type).filter(Boolean))],
    ids: { tvdb: String(d.id ?? tvdbId), imdb: remoteId(d, "imdb"), tmdb: remoteId(d, "themoviedb") || remoteId(d, "tmdb") },
  }
})

/** Season layout for one TVDB episode order ("default", "official", "absolute", ...). */
exports.getLayout = (tvdbId, order = "default") => cache.wrap(`tvdb:layout:${tvdbId}:${order}`, async () => {
  if (!ORDERS.includes(order)) throw new Error(`unknown TVDB order ${order}`)
  const episodes = []
  for (let page = 0; page < 20; page++) {
    const data = await get(`/series/${encodeURIComponent(tvdbId)}/episodes/${order}?page=${page}`)
    const rows = data?.data?.episodes || []
    for (const e of rows) episodes.push({ season: e.seasonNumber, episode: e.number, released: e.aired })
    if (!data?.links?.next || rows.length === 0) break
  }
  return seasonLayout(episodes)
})
