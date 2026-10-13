const express = require("express")
const { buildManifest, TYPES } = require("./stremio/manifest")
const { resolve } = require("./identification/resolver")
const { getStreams } = require("./stremio/streams")
const { TTLCache } = require("./utils/cache")
const { ORDERS } = require("./providers/tvdb")
const { urlExpiry } = require("./utils/expiry")
const { withContext } = require("./utils/context")

const NUMBERINGS = ["auto", "cinemeta", "tmdb", "tvdb", ...ORDERS.map((o) => `tvdb-${o}`)]

const REQUEST_TIMEOUT_MS = Number(process.env.STREAM_TIMEOUT_MS) || 25000
const MIN = 60 * 1000
const STREAMS_TTL_MS = 10 * MIN
const EMPTY_TTL_MS = 2 * MIN
const ERROR_TTL_MS = 1 * MIN
// A cached link must still have this long to live when it is served.
const EXPIRY_MARGIN_MS = 2 * MIN
const responseCache = new TTLCache({ ttlMs: STREAMS_TTL_MS })
exports.responseCache = responseCache

/**
 * How long a stream list may be reused: 10 min, or less when a link states
 * an earlier expiry (signed URLs, see utils/expiry.js); 2 min when empty.
 */
function streamsTtl(streams, now = Date.now()) {
  if (!streams.length) return EMPTY_TTL_MS
  const expiries = streams.map((s) => urlExpiry(s.url, now)).filter(Boolean)
  if (!expiries.length) return STREAMS_TTL_MS
  return Math.max(0, Math.min(STREAMS_TTL_MS, Math.min(...expiries) - now - EXPIRY_MARGIN_MS))
}
exports.streamsTtl = streamsTtl

const log = (...args) => { if (process.env.NODE_ENV !== "test") console.log(...args) }

/** Only known keys survive; anything else in the config segment is ignored. */
function parseConfig(segment) {
  const config = {}
  if (!segment) return config
  let params
  try { params = new URLSearchParams(decodeURIComponent(segment)) } catch { return config }
  const numbering = params.get("numbering")
  if (NUMBERINGS.includes(numbering)) config.numbering = numbering
  const mapping = params.get("mapping")
  if (["auto", "season", "absolute"].includes(mapping)) config.mapping = mapping
  return config
}

function cors(_req, res, next) {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  })
  next()
}

function sendStreams(res, streams) {
  const ttl = streams.length ? streamsTtl(streams) : ERROR_TTL_MS
  const maxAge = Math.floor(ttl / 1000)
  // Links that expire soon must not be replayed from a stale cache either.
  const staleError = ttl < STREAMS_TTL_MS && streams.length ? maxAge : 3600
  res.set("Cache-Control", `max-age=${maxAge}, stale-while-revalidate=${maxAge}, stale-if-error=${staleError}`)
  res.json({ streams, cacheMaxAge: maxAge, staleRevalidate: maxAge, staleError })
}

async function findStreams(type, id, config) {
  const target = await resolve(type, id, config)
  log(`[stream] ${type} ${id} -> ${target.slug} ep ${target.episode} (${target.via})`)
  return getStreams(target)
}

async function handleStream(req, res) {
  const { type, id } = req.params
  const config = parseConfig(req.params.config)
  if (!TYPES.includes(type)) return sendStreams(res, [])
  const key = `${config.numbering || "auto"}|${config.mapping || "auto"}|${type}|${id}`
  let streams = []
  try {
    streams = await responseCache.wrap(key, () => {
      // On timeout, every request still pending for this id is cancelled too.
      const ctl = new AbortController()
      let timer
      return Promise.race([
        withContext({ signal: ctl.signal }, () => findStreams(type, id, config)),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error(`timed out after ${REQUEST_TIMEOUT_MS} ms`)
            err.code = "TIMEOUT"
            ctl.abort(err)
            reject(err)
          }, REQUEST_TIMEOUT_MS)
        }),
      ]).finally(() => clearTimeout(timer))
    }, (list) => streamsTtl(list))
  } catch (err) {
    log(`[stream] ${type} ${id}: no streams (${err.code || err.name}: ${err.message})`)
    // Brief negative cache so a failing id does not hammer JKAnime; a
    // temporary error (blocked, timeout) is never remembered for long.
    responseCache.set(key, Promise.resolve([]), ERROR_TTL_MS)
  }
  sendStreams(res, streams)
}

function sendManifest(req, res) {
  res.set("Cache-Control", "max-age=3600")
  res.json(buildManifest(parseConfig(req.params.config)))
}

exports.createApp = function createApp() {
  const app = express()
  app.disable("x-powered-by")
  app.use(cors)
  app.options("*", (_req, res) => res.sendStatus(204))

  app.get("/", (req, res) => {
    const manifestUrl = `${req.protocol}://${req.get("host")}/manifest.json`
    res.type("html").send(`<!doctype html><meta charset="utf-8"><title>JKAnimeNuvio</title>
<h1>JKAnimeNuvio</h1><p>Addon de streams (solo <code>stream</code>) de JKAnime.</p>
<p>Instala en Nuvio o Stremio con: <code>${manifestUrl.replace(/</g, "&lt;")}</code></p>`)
  })
  app.get("/health", (_req, res) => res.json({ ok: true }))

  app.get("/manifest.json", sendManifest)
  app.get("/:config/manifest.json", sendManifest)

  app.get("/stream/:type/:id/:extra.json", handleStream)
  app.get("/stream/:type/:id.json", handleStream)
  app.get("/:config/stream/:type/:id/:extra.json", handleStream)
  app.get("/:config/stream/:type/:id.json", handleStream)

  app.use((_req, res) => res.status(404).json({ error: "not found" }))
  return app
}
