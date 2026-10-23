/**
 * /status (optional, STATUS_ENABLED=true): enough to tell at a glance whether
 * the instance is healthy and whether JKAnime answers from this IP. No
 * credentials, no token, no media or signed URLs.
 */
const pkg = require("../package.json")
const tmdb = require("./providers/tmdb")
const tvdb = require("./providers/tvdb")
const cinemeta = require("./providers/cinemeta")
const relations = require("./providers/relations")
const { cacheStats } = require("./utils/cache")
const upstream = require("./utils/upstream")

const mb = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10
const num = (name, fallback) => Number(process.env[name]) || fallback

/** Explains the latest JKAnime outcome in one sentence. */
function verdict(jk) {
  if (!jk.last) return "Sin peticiones a JKAnime todavía: pide un episodio (p. ej. tt7441658:1:1) y vuelve a mirar."
  if (jk.last.result === "OK") return "JKAnime responde desde este servidor."
  if (jk.last.result === "BLOCKED") return "JKAnime (Cloudflare) bloquea la IP de este servidor: no habrá streams desde aquí."
  return `La última petición a JKAnime falló (${jk.last.code}); puede ser temporal.`
}

function buildStatus({ clientIp } = {}) {
  const mem = process.memoryUsage()
  const jkanime = upstream.snapshot()
  return {
    name: "JKAnimeNuvio",
    version: pkg.version,
    node: process.version,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMB: { rss: mb(mem.rss), heapUsed: mb(mem.heapUsed), heapTotal: mb(mem.heapTotal) },
    caches: cacheStats(),
    providers: {
      tmdb: tmdb.enabled(),
      tvdb: tvdb.enabled(),
      cinemeta: cinemeta.enabled(),
      relations: relations.enabled(),
      metadataProvider: (process.env.METADATA_PROVIDER || "auto").trim() || "auto",
    },
    security: {
      token: Boolean((process.env.ADDON_TOKEN || "").trim()),
      rateLimitPerMin: num("RATE_LIMIT_PER_MIN", 0) || null,
      trustProxy: (process.env.TRUST_PROXY || "").trim() || null,
    },
    limits: {
      JK_CONCURRENCY: num("JK_CONCURRENCY", 3),
      HTTP_MAX_CONCURRENCY: num("HTTP_MAX_CONCURRENCY", 16),
      HTTP_MAX_PER_HOST: num("HTTP_MAX_PER_HOST", 4),
      STREAM_TIMEOUT_MS: num("STREAM_TIMEOUT_MS", 25000),
      EXTRACT_TIMEOUT_MS: num("EXTRACT_TIMEOUT_MS", 12000),
      CACHE_MAX_ENTRIES: num("CACHE_MAX_ENTRIES", 0) || null,
    },
    // The address this server sees for you: lets you check TRUST_PROXY behind a proxy.
    yourIp: clientIp || null,
    jkanime: { ...jkanime, verdict: verdict(jkanime) },
  }
}

module.exports = { buildStatus }
