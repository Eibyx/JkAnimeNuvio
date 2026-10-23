const crypto = require("node:crypto")
const express = require("express")
const { buildManifest, TYPES } = require("./stremio/manifest")
const { resolve } = require("./identification/resolver")
const { getStreams } = require("./stremio/streams")
const { TTLCache } = require("./utils/cache")
const { ORDERS } = require("./providers/tvdb")
const { urlExpiry } = require("./utils/expiry")
const { withContext } = require("./utils/context")
const { rateLimit } = require("./utils/ratelimit")
const { buildStatus } = require("./status")

const NUMBERINGS = ["auto", "cinemeta", "tmdb", "tvdb", ...ORDERS.map((o) => `tvdb-${o}`)]

const REQUEST_TIMEOUT_MS = Number(process.env.STREAM_TIMEOUT_MS) || 25000
const MIN = 60 * 1000
const STREAMS_TTL_MS = 10 * MIN
const EMPTY_TTL_MS = 2 * MIN
const ERROR_TTL_MS = 1 * MIN
// A cached link must still have this long to live when it is served.
const EXPIRY_MARGIN_MS = 2 * MIN
const responseCache = new TTLCache({ ttlMs: STREAMS_TTL_MS, name: "streams" })
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

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:.]+\](:\d{1,5})?$/i

/**
 * Base URL clients use to reach this server: PUBLIC_URL when set, otherwise
 * what a reverse proxy (Koyeb, a tunnel) reports in X-Forwarded-Proto/Host,
 * otherwise the request itself. Only shown back to the requester.
 */
function publicBase(req) {
  const configured = (process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "")
  if (/^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(configured)) return configured
  const first = (name) => String(req.get(name) || "").split(",")[0].trim()
  const proto = /^https?$/i.test(first("x-forwarded-proto")) ? first("x-forwarded-proto").toLowerCase() : req.protocol
  const forwardedHost = first("x-forwarded-host")
  const host = HOST_RE.test(forwardedHost) ? forwardedHost : req.get("host")
  return `${proto}://${host}`
}
exports.publicBase = publicBase

/** TRUST_PROXY as Express understands it: true/false, a hop count or a list of subnets. */
function trustProxySetting(value) {
  const v = String(value || "").trim()
  if (!v) return null
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === "true"
  if (/^\d+$/.test(v)) return Number(v)
  return v
}
exports.trustProxySetting = trustProxySetting

/** ADDON_TOKEN must fit in one URL path segment without escaping. */
function readToken() {
  const token = (process.env.ADDON_TOKEN || "").trim()
  if (!token) return null
  if (!/^[A-Za-z0-9._~-]+$/.test(token)) {
    throw new Error("ADDON_TOKEN may only contain letters, digits and . _ ~ - (it goes in the URL)")
  }
  if (token.length < 16) console.warn("[security] ADDON_TOKEN is short; use at least 16 random characters")
  return token
}

const digest = (s) => crypto.createHash("sha256").update(s).digest()

/**
 * Lets a request through only when its first path segment is the token,
 * and strips that segment so the addon routes below match as usual. The
 * comparison runs in constant time (both sides hashed to the same length).
 * The token never reaches a log: nothing here logs URLs.
 */
function tokenGate(token, router) {
  const expected = digest(token)
  return function tokenGateMiddleware(req, res, next) {
    const m = /^\/([^/?]*)(.*)$/s.exec(req.url)
    const given = m ? m[1] : ""
    if (!crypto.timingSafeEqual(digest(given), expected)) return next()
    const original = req.url
    req.url = m[2].startsWith("/") ? m[2] : "/" + m[2]
    req.tokenPrefix = `/${token}`
    router(req, res, (err) => {
      req.url = original
      // Unknown paths under the token fall through to the JSON 404.
      next(err)
    })
  }
}

function installPage(req, res) {
  const prefix = req.tokenPrefix || ""
  const manifestUrl = `${publicBase(req)}${prefix}/manifest.json`
  res.type("html").send(`<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>JKAnimeNuvio</title>
<h1>JKAnimeNuvio</h1><p>Addon de streams (solo <code>stream</code>) de JKAnime.</p>
<p>Instala en Nuvio o Stremio con: <code>${escapeHtml(manifestUrl)}</code></p>`)
}

/** Addon routes: install page, manifests, streams and the optional /status. */
function addonRoutes({ statusEnabled }) {
  const router = express.Router()
  router.get("/", installPage)
  if (statusEnabled) router.get("/status", sendStatus)
  router.get("/manifest.json", sendManifest)
  router.get("/:config/manifest.json", sendManifest)
  router.get("/stream/:type/:id/:extra.json", handleStream)
  router.get("/stream/:type/:id.json", handleStream)
  router.get("/:config/stream/:type/:id/:extra.json", handleStream)
  router.get("/:config/stream/:type/:id.json", handleStream)
  return router
}

function sendStatus(req, res) {
  res.set("Cache-Control", "no-store")
  res.json(buildStatus({ clientIp: req.ip }))
}

/**
 * Options come from the environment (see .env.example); with none of the
 * new variables set, the routes behave exactly as before.
 */
exports.createApp = function createApp() {
  const token = readToken()
  const perMinute = Number(process.env.RATE_LIMIT_PER_MIN)
  const statusEnabled = /^true$/i.test(process.env.STATUS_ENABLED || "")
  const trust = trustProxySetting(process.env.TRUST_PROXY)

  const app = express()
  app.disable("x-powered-by")
  if (trust !== null) app.set("trust proxy", trust)
  app.use(cors)
  app.options("*", (_req, res) => res.sendStatus(204))

  // Health check for Koyeb/Docker: instant, never touches the network or the token.
  app.get("/health", (_req, res) => res.json({ ok: true }))

  if (perMinute > 0) app.use(rateLimit({ perMinute: Math.floor(perMinute) }))

  const routes = addonRoutes({ statusEnabled })
  app.use(token ? tokenGate(token, routes) : routes)

  app.use((_req, res) => res.status(404).json({ error: "not found" }))
  // Never send stack traces, paths or messages to the client (Express's
  // default handler does outside production, e.g. for a malformed %-escape).
  app.use((err, _req, res, _next) => {
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 ? err.status : 500
    if (status === 500) log(`[http] internal error: ${err?.name || "Error"}${err?.code ? ` (${err.code})` : ""}`)
    if (res.headersSent) return res.end()
    res.status(status).json({ error: status === 500 ? "internal error" : "bad request" })
  })
  return app
}
