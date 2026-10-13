const net = require("node:net")

const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36"
const DEFAULT_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS) || 10000
const MAX_BODY_BYTES = 5 * 1024 * 1024

// Tests swap this out so nothing touches the network.
let fetchImpl = (...args) => globalThis.fetch(...args)
exports.setFetch = (fn) => { fetchImpl = fn }
exports.resetFetch = () => { fetchImpl = (...args) => globalThis.fetch(...args) }
exports.DEFAULT_UA = DEFAULT_UA

const SECRET_PARAMS = /([?&](?:api_key|apikey|token|pin|access_token)=)[^&#]*/gi

/** Removes credentials from URLs before they reach logs or error messages. */
function redactUrl(value) {
  return String(value).replace(SECRET_PARAMS, "$1***")
}
exports.redactUrl = redactUrl

class HttpError extends Error {
  constructor(message, status, url) {
    super(redactUrl(message))
    this.name = "HttpError"
    this.status = status
    this.url = url === undefined ? url : redactUrl(url)
  }
}
exports.HttpError = HttpError

class BlockedError extends HttpError {
  constructor(url, status) {
    super(`Blocked by an anti-bot challenge (Cloudflare) at ${url}`, status, url)
    this.name = "BlockedError"
  }
}
exports.BlockedError = BlockedError

function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number)
  return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    p[0] >= 224
}

/**
 * Parses a URL and rejects anything that is not a public http(s) target.
 * Embed URLs come from scraped pages, so this keeps them from pointing the
 * addon at localhost or the internal network.
 * @returns {URL|null}
 */
function safeUrl(value, base = undefined) {
  let url
  try { url = new URL(value, base) } catch { return null }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  if (url.username || url.password) return null
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return null
  const ipType = net.isIP(host)
  if (ipType === 4 && isPrivateIPv4(host)) return null
  if (ipType === 6) {
    if (host === "::" || host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return null
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped && isPrivateIPv4(mapped[1])) return null
  }
  return url
}
exports.safeUrl = safeUrl

function isChallenge(resp, body) {
  if (resp.headers?.get?.("cf-mitigated") === "challenge") return true
  if (resp.status !== 403 && resp.status !== 503) return false
  return typeof body === "string" && /<title>\s*Just a moment\.\.\.\s*<\/title>|challenges\.cloudflare\.com/i.test(body)
}

/**
 * fetch() with timeout, URL safety checks, browser-like headers and
 * Cloudflare challenge detection.
 * @returns {Promise<{text: string, url: string, status: number}>}
 */
async function request(target, { headers = {}, method = "GET", body, timeout = DEFAULT_TIMEOUT_MS, referer, retries429 = 1 } = {}) {
  const url = safeUrl(target)
  if (!url) throw new HttpError(`Refusing unsafe URL: ${target}`, 0, String(target))
  const finalHeaders = {
    "User-Agent": DEFAULT_UA,
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
    ...(referer ? { Referer: referer } : {}),
    ...headers,
  }
  const resp = await fetchImpl(url.href, {
    method, body, headers: finalHeaders, redirect: "follow",
    signal: AbortSignal.timeout(timeout),
  })
  // A redirect can only land somewhere safe.
  if (resp.url && !safeUrl(resp.url)) throw new HttpError(`Redirected to unsafe URL: ${resp.url}`, resp.status, resp.url)
  const text = await resp.text()
  if (text.length > MAX_BODY_BYTES) throw new HttpError(`Response too large from ${url.href}`, resp.status, url.href)
  if (isChallenge(resp, text)) throw new BlockedError(url.href, resp.status)
  if (resp.status === 429 && retries429 > 0) {
    // Rate limited: honour Retry-After once (capped) instead of hammering the API.
    const wait = Math.min(Number(resp.headers?.get?.("retry-after")) || 1, 5) * 1000
    await new Promise((r) => setTimeout(r, wait))
    return request(target, { headers, method, body, timeout, referer, retries429: retries429 - 1 })
  }
  if (!resp.ok) throw new HttpError(`HTTP ${resp.status} for ${url.href}`, resp.status, url.href)
  return { text, url: resp.url || url.href, status: resp.status }
}
exports.request = request

exports.fetchText = async (url, opts) => (await request(url, opts)).text

exports.fetchJson = async (url, opts = {}) => {
  const { text } = await request(url, { ...opts, headers: { Accept: "application/json", ...(opts.headers || {}) } })
  try { return JSON.parse(text) } catch { throw new HttpError(`Invalid JSON from ${url}`, 200, url) }
}
