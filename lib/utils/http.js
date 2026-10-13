const net = require("node:net")
const dns = require("node:dns")
const { isBlockedIp } = require("./ip")
const { limiter } = require("./limiter")
const context = require("./context")

const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36"
const DEFAULT_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS) || 10000
const MAX_BODY_BYTES = 5 * 1024 * 1024
const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
// Requests in flight per host and in total, so one Stremio request (or many
// at once) cannot flood JKAnime or a video host.
const PER_HOST = Number(process.env.HTTP_MAX_PER_HOST) || 4
const TOTAL = Number(process.env.HTTP_MAX_CONCURRENCY) || 16

const defaultFetch = (...args) => globalThis.fetch(...args)
const defaultLookup = (host) => dns.promises.lookup(host, { all: true, verbatim: true })

// Tests swap these out so nothing touches the network. A fake fetch also
// disables the DNS check unless the test installs its own resolver.
let fetchImpl = defaultFetch
let lookupImpl = defaultLookup
exports.setFetch = (fn) => { fetchImpl = fn; lookupImpl = null }
exports.setLookup = (fn) => { lookupImpl = fn }
exports.resetFetch = () => { fetchImpl = defaultFetch; lookupImpl = defaultLookup }
exports.DEFAULT_UA = DEFAULT_UA
exports.MAX_BODY_BYTES = MAX_BODY_BYTES

const SECRET_PARAMS = /([?&](?:api_key|apikey|token|pin|access_token|_token|key|sig|signature)=)[^&#]*/gi

/** Removes credentials from URLs before they reach logs or error messages. */
function redactUrl(value) {
  return String(value).replace(SECRET_PARAMS, "$1***")
}
exports.redactUrl = redactUrl

/**
 * Origin and path only: the query string of an embed or media URL often
 * carries signed tokens, so it never reaches a log line.
 */
function logUrl(value) {
  try {
    const u = new URL(String(value))
    return `${u.origin}${u.pathname}${u.search ? "?…" : ""}`
  } catch {
    return redactUrl(value).slice(0, 200)
  }
}
exports.logUrl = logUrl

/**
 * code: HTTP_404, HTTP_419, HTTP_429, HTTP_5XX, HTTP_<status>, TIMEOUT,
 * BLOCKED, UNSAFE_URL, TOO_LARGE, TOO_MANY_REDIRECTS, NETWORK_ERROR.
 */
class HttpError extends Error {
  constructor(message, status, url, code) {
    super(redactUrl(message))
    this.name = "HttpError"
    this.status = status
    this.url = url === undefined ? url : logUrl(url)
    this.code = code || HttpError.codeFor(status)
  }

  static codeFor(status) {
    if (!status) return "NETWORK_ERROR"
    if (status >= 500) return "HTTP_5XX"
    return `HTTP_${status}`
  }
}
exports.HttpError = HttpError

class BlockedError extends HttpError {
  constructor(url, status) {
    super(`Blocked by an anti-bot challenge (Cloudflare) at ${logUrl(url)}`, status, url, "BLOCKED")
    this.name = "BlockedError"
  }
}
exports.BlockedError = BlockedError

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"]

/**
 * Parses a URL and rejects anything that is not a public http(s) target.
 * Embed URLs come from scraped pages, so this keeps them from pointing the
 * addon at localhost or the internal network. It only sees the literal host;
 * request() also checks what a hostname resolves to.
 * @returns {URL|null}
 */
function safeUrl(value, base = undefined) {
  let url
  try { url = new URL(value, base) } catch { return null }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  if (url.username || url.password) return null
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "")
  if (!host || host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return null
  if (net.isIP(host) && isBlockedIp(host)) return null
  // Single-label names ("router", "intranet") only exist on local networks.
  if (!net.isIP(host) && !host.includes(".")) return null
  return url
}
exports.safeUrl = safeUrl

/**
 * Rejects hostnames that resolve to internal addresses. It runs right before
 * each connection, but fetch() resolves the name again: a hostile DNS server
 * answering differently within milliseconds (TTL 0) is NOT stopped by this
 * check (residual risk, see docs/AUDITORIA.md S3). A failed lookup is let
 * through because fetch would fail the same way (or a proxy resolves it).
 */
async function assertPublicHost(url) {
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (!lookupImpl || net.isIP(host)) return
  let addresses
  try {
    addresses = await lookupImpl(host)
  } catch {
    // Unresolvable here: fetch fails on its own (or a proxy resolves it).
    return
  }
  const bad = (addresses || []).find((a) => isBlockedIp(a.address ?? a))
  if (bad) throw new HttpError(`Refusing ${host}: resolves to a non-public address`, 0, url.href, "UNSAFE_URL")
}

function isChallenge(resp, body) {
  if (resp.headers?.get?.("cf-mitigated") === "challenge") return true
  if (resp.status !== 403 && resp.status !== 503) return false
  return typeof body === "string" && /<title>\s*Just a moment\.\.\.\s*<\/title>|challenges\.cloudflare\.com/i.test(body)
}

/** Reads a body as UTF-8, stopping as soon as it exceeds maxBytes. */
async function readBody(resp, maxBytes, href, signal) {
  const tooLarge = () => new HttpError(`Response too large from ${logUrl(href)}`, resp.status, href, "TOO_LARGE")
  const declared = Number(resp.headers?.get?.("content-length"))
  if (declared > maxBytes) {
    resp.body?.cancel?.().catch(() => {})
    throw tooLarge()
  }
  if (resp.body && typeof resp.body.getReader === "function") {
    const reader = resp.body.getReader()
    // Not every body stream reacts to the abort signal: race it explicitly.
    const aborted = new Promise((_, reject) => {
      if (signal?.aborted) reject(signal.reason)
      signal?.addEventListener("abort", () => { reject(signal.reason); reader.cancel().catch(() => {}) }, { once: true })
    })
    aborted.catch(() => {})
    const chunks = []
    let total = 0
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted])
      if (done) {
        if (signal?.aborted) throw signal.reason
        break
      }
      total += value.byteLength
      if (total > maxBytes) {
        reader.cancel().catch(() => {})
        throw tooLarge()
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
    }
    return Buffer.concat(chunks).toString("utf8")
  }
  const text = await resp.text()
  if (Buffer.byteLength(text) > maxBytes) throw tooLarge()
  return text
}

const hostLimits = new Map()
const totalLimit = limiter(TOTAL)
function limited(host, fn) {
  if (!hostLimits.has(host)) {
    if (hostLimits.size > 500) hostLimits.clear()
    hostLimits.set(host, limiter(PER_HOST))
  }
  return hostLimits.get(host)(() => totalLimit(fn))
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms)
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason) }, { once: true })
})

/**
 * fetch() with URL and DNS safety checks on every redirect hop, a timeout that
 * covers the whole body, a size cap, browser-like headers and Cloudflare
 * challenge detection. Cancelled early when the request context is aborted.
 * @returns {Promise<{text: string, url: string, status: number, headers: Headers}>}
 */
async function request(target, { headers = {}, method = "GET", body, timeout = DEFAULT_TIMEOUT_MS, referer, retries429 = 1, maxBytes = MAX_BODY_BYTES } = {}) {
  // Redirects may turn a POST into a GET; a 429 retry starts over from the original.
  const originalMethod = method
  const originalBody = body
  let url = safeUrl(target)
  if (!url) throw new HttpError(`Refusing unsafe URL: ${logUrl(target)}`, 0, String(target), "UNSAFE_URL")
  let hopHeaders = {
    "User-Agent": DEFAULT_UA,
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
    ...(referer ? { Referer: referer } : {}),
    ...headers,
  }
  const outer = context.current().signal
  if (outer?.aborted) throw outer.reason
  const timer = new AbortController()
  const timeoutError = new HttpError(`Request to ${logUrl(url.href)} timed out after ${timeout} ms`, 0, url.href, "TIMEOUT")
  const handle = setTimeout(() => timer.abort(timeoutError), timeout)
  const signal = outer && AbortSignal.any ? AbortSignal.any([timer.signal, outer]) : timer.signal

  try {
    for (let hop = 0; ; hop++) {
      context.countRequest(url.hostname)
      const current = url
      const result = await limited(current.hostname, async () => {
        await assertPublicHost(current)
        const resp = await fetchImpl(current.href, { method, body, headers: hopHeaders, redirect: "manual", signal })
        const location = REDIRECT_STATUSES.has(resp.status) ? resp.headers?.get?.("location") : null
        if (location) {
          resp.body?.cancel?.().catch(() => {})
          return { resp, location }
        }
        return { resp, text: await readBody(resp, maxBytes, current.href, signal) }
      })
      const { resp } = result

      if (result.location) {
        if (hop >= MAX_REDIRECTS) throw new HttpError(`Too many redirects from ${logUrl(target)}`, resp.status, String(target), "TOO_MANY_REDIRECTS")
        const next = safeUrl(result.location, current)
        if (!next) throw new HttpError(`Redirected to unsafe URL: ${logUrl(result.location)}`, resp.status, current.href, "UNSAFE_URL")
        if (resp.status === 303 || ((resp.status === 301 || resp.status === 302) && method === "POST")) {
          method = "GET"
          body = undefined
          hopHeaders = Object.fromEntries(Object.entries(hopHeaders).filter(([k]) => !/^content-/i.test(k)))
        }
        if (next.origin !== current.origin) {
          // Credentials and session cookies belong to the origin that asked for them.
          hopHeaders = Object.fromEntries(Object.entries(hopHeaders).filter(([k]) => !/^(authorization|cookie|origin)$/i.test(k)))
        }
        url = next
        continue
      }

      // A test double (or a runtime without manual redirects) may report the
      // final URL of a redirect it followed itself: it must be safe too.
      const finalUrl = resp.url ? safeUrl(resp.url) : current
      if (!finalUrl) throw new HttpError(`Redirected to unsafe URL: ${logUrl(resp.url)}`, resp.status, resp.url, "UNSAFE_URL")
      const text = result.text
      context.current().onBody?.(text, resp.status)
      if (isChallenge(resp, text)) throw new BlockedError(current.href, resp.status)
      if (resp.status === 429 && retries429 > 0) {
        // Rate limited: honour Retry-After once (capped) instead of hammering the API.
        const wait = Math.min(Number(resp.headers?.get?.("retry-after")) || 1, 5) * 1000
        await sleep(wait, signal)
        clearTimeout(handle)
        return request(target, { headers, method: originalMethod, body: originalBody, timeout, referer, retries429: retries429 - 1, maxBytes })
      }
      if (!resp.ok) throw new HttpError(`HTTP ${resp.status} for ${logUrl(current.href)}`, resp.status, current.href)
      return { text, url: finalUrl.href, status: resp.status, headers: resp.headers }
    }
  } catch (err) {
    if (signal.aborted) {
      const reason = signal.reason
      throw reason instanceof Error ? reason : new HttpError(`Request to ${logUrl(url.href)} aborted`, 0, url.href, "TIMEOUT")
    }
    if (err instanceof HttpError) throw err
    throw new HttpError(`Network error for ${logUrl(url.href)}: ${err.cause?.code || err.message}`, 0, url.href, "NETWORK_ERROR")
  } finally {
    clearTimeout(handle)
  }
}
exports.request = request

exports.fetchText = async (url, opts) => (await request(url, opts)).text

exports.fetchJson = async (url, opts = {}) => {
  const { text } = await request(url, { ...opts, headers: { Accept: "application/json", ...(opts.headers || {}) } })
  try { return JSON.parse(text) } catch { throw new HttpError(`Invalid JSON from ${logUrl(url)}`, 200, url, "PARSER_CHANGED") }
}
