const express = require("express")
const { buildManifest, TYPES } = require("./stremio/manifest")
const { resolve } = require("./identification/resolver")
const { getStreams } = require("./stremio/streams")
const { TTLCache } = require("./utils/cache")
const { ORDERS } = require("./providers/tvdb")

const NUMBERINGS = ["auto", "cinemeta", "tmdb", "tvdb", ...ORDERS.map((o) => `tvdb-${o}`)]

const REQUEST_TIMEOUT_MS = Number(process.env.STREAM_TIMEOUT_MS) || 25000
const responseCache = new TTLCache({ ttlMs: 10 * 60 * 1000 })
exports.responseCache = responseCache

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
  const maxAge = streams.length ? 600 : 60
  res.set("Cache-Control", `max-age=${maxAge}, stale-while-revalidate=${maxAge}, stale-if-error=3600`)
  res.json({ streams, cacheMaxAge: maxAge, staleRevalidate: maxAge, staleError: 3600 })
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
      let timer
      return Promise.race([
        findStreams(type, id, config),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), REQUEST_TIMEOUT_MS) }),
      ]).finally(() => clearTimeout(timer))
    })
    if (streams.length === 0) responseCache.set(key, Promise.resolve(streams), 2 * 60 * 1000)
  } catch (err) {
    log(`[stream] ${type} ${id}: no streams (${err.name}: ${err.message})`)
    // Brief negative cache so a failing id does not hammer JKAnime.
    responseCache.set(key, Promise.resolve([]), 60 * 1000)
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
