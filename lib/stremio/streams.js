/**
 * Builds Stremio stream objects for a resolved JKAnime episode.
 * https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/stream.md
 */
const jkanime = require("../jkanime/site")
const extractors = require("../jkanime/extractors")
const { DEFAULT_UA, HttpError, request } = require("../utils/http")
const { errorCode } = require("../utils/errors")
const { withContext, trace } = require("../utils/context")

const extractTimeout = () => Number(process.env.EXTRACT_TIMEOUT_MS) || 12000
const PROBE_TIMEOUT_MS = 5000

/**
 * Why a server produced no link, as a stable code (see lib/utils/errors.js).
 * Runs after the episode was already found, so none of these is an
 * identification problem.
 */
function classifyFailure(err) {
  return errorCode(err)
}
exports.classifyFailure = classifyFailure

// Worded so that no code claims more than it knows: a 404 can be a deleted
// video or a moved page.
const FAILURE_TEXT = {
  HTTP_404: "HTTP 404: el servidor no encontró el vídeo o la página (eliminado o ruta cambiada)",
  HTTP_410: "HTTP 410: el servidor indica que el vídeo ya no existe",
  HTTP_419: "HTTP 419: sesión o token rechazados",
  HTTP_429: "HTTP 429: demasiadas peticiones; prueba más tarde",
  HTTP_5XX: "error del servidor (HTTP 5xx)",
  TIMEOUT: "sin respuesta a tiempo",
  BLOCKED: "bloqueado por un desafío anti-bots (Cloudflare)",
  UNSAFE_URL: "dirección rechazada por seguridad (red interna)",
  TOO_LARGE: "respuesta demasiado grande",
  NETWORK_ERROR: "error de red",
  PARSER_CHANGED: "la página cargó pero no tiene el formato esperado (¿cambió el reproductor?)",
  UNSUPPORTED_FORMAT: "formato del servidor no compatible con este extractor",
  INVALID_MEDIA_URL: "el enlace obtenido no es un MP4/HLS directo",
  NO_MEDIA: "el servidor indica que el vídeo no está disponible",
  EXTRACTOR_ERROR: "error inesperado del extractor",
}
exports.FAILURE_TEXT = FAILURE_TEXT

/**
 * Runs one extractor with a deadline that really cancels: every request it
 * makes shares an abort signal that fires when the deadline passes.
 */
function extractWithDeadline(job) {
  const ctl = new AbortController()
  const ms = extractTimeout()
  const timer = setTimeout(() => ctl.abort(new HttpError(`${job.name} timed out after ${ms} ms`, 0, undefined, "TIMEOUT")), ms)
  const aborted = new Promise((_, reject) => ctl.signal.addEventListener("abort", () => reject(ctl.signal.reason), { once: true }))
  return Promise.race([withContext({ signal: ctl.signal }, () => extractors.extract(job.embed, job.name)), aborted])
    .finally(() => clearTimeout(timer))
}

/**
 * Optional lightweight check (STREAM_PROBE=true): an HLS playlist must start
 * with #EXTM3U; an MP4 must answer a 1-byte range request. Never downloads the
 * video, never uses HEAD (many hosts reject it). Real playback is still only
 * proven by playing it in Nuvio.
 * @returns {Promise<string|null>} failure code, or null when the link answers
 */
async function probe(media) {
  const headers = { ...media.headers, ...(media.kind === "mp4" ? { Range: "bytes=0-0" } : {}) }
  try {
    const { text } = await request(media.url, { headers, timeout: PROBE_TIMEOUT_MS, maxBytes: 512 * 1024, retries429: 0 })
    if (media.kind === "hls" && !/^\s*#EXTM3U/.test(text)) return "INVALID_MEDIA_URL"
    return null
  } catch (err) {
    // Too large means the host ignored the range and started sending video: it answers.
    return err.code === "TOO_LARGE" ? null : errorCode(err)
  }
}
exports.probe = probe

const LANG = {
  1: { tag: "SUB", text: "Japonés · subtítulos en español" },
  3: { tag: "LAT", text: "Doblaje latino" },
}
const langOf = (code) => LANG[code] || { tag: "DUB", text: "Doblaje" }

/** Formats one direct media result as a Stremio stream object. */
function toStream(media, { lang, label }) {
  const l = langOf(lang)
  const format = media.kind === "hls" ? "HLS" : "MP4"
  const description = `${label}\n${media.server} · ${format} · ${l.text}`
  return {
    name: `JKAnime\n${media.server} ${l.tag}`,
    title: description,
    description,
    url: media.url,
    behaviorHints: {
      bingeGroup: `jkanimenuvio|${media.serverKey}|${l.tag}`,
      notWebReady: true,
      proxyHeaders: { request: { "User-Agent": DEFAULT_UA, ...media.headers } },
    },
  }
}

/**
 * @param {{slug: string, episode: number, label: string}} target
 * @returns {Promise<Array<object>>} Stremio streams (direct MP4/HLS only)
 */
exports.getStreams = async function getStreams(target) {
  const page = await jkanime.getEpisode(target.slug, target.episode)
  const jobs = [
    ...page.players.map((embed) => ({ embed, name: "JKAnime", lang: 1 })),
    ...page.servers.map((s) => ({ embed: s.embed, name: s.name, lang: s.lang })),
  ].filter((job) => extractors.pickExtractor(job.embed, job.name))
  trace("servers", { listed: page.servers.length + page.players.length, supported: jobs.length, names: jobs.map((j) => j.name) })

  const settled = await Promise.allSettled(jobs.map(async (job) => {
    const t0 = Date.now()
    try {
      const found = await extractWithDeadline(job)
      trace("server", { name: job.name, lang: job.lang, links: found.length, kinds: found.map((m) => m.kind), ms: Date.now() - t0 })
      return found.map((media) => ({ media, lang: job.lang }))
    } catch (err) {
      trace("server", { name: job.name, lang: job.lang, links: 0, code: errorCode(err), ms: Date.now() - t0 })
      throw err
    }
  }))

  const streams = []
  const seen = new Set()
  const failures = []
  const candidates = []
  settled.forEach((r, i) => {
    if (r.status === "rejected") {
      const code = classifyFailure(r.reason)
      failures.push(`${jobs[i].name}: ${code}`)
      if (process.env.NODE_ENV !== "test") {
        // Messages carry origin + path only (lib/utils/http.js logUrl), never signed queries.
        console.warn(`[streams] ${target.slug} ep ${target.episode} · ${jobs[i].name}: ${code} — ${FAILURE_TEXT[code] || code}`)
      }
      return
    }
    for (const item of r.value) {
      if (seen.has(item.media.url)) continue
      seen.add(item.media.url)
      candidates.push(item)
    }
  })
  if (process.env.STREAM_PROBE === "true" && candidates.length) {
    const checks = await Promise.all(candidates.map(({ media }) => probe(media)))
    checks.forEach((code, i) => {
      if (code) failures.push(`${candidates[i].media.server}: probe ${code}`)
      trace("probe", { server: candidates[i].media.server, kind: candidates[i].media.kind, ok: !code, code })
    })
    for (let i = candidates.length - 1; i >= 0; i--) if (checks[i]) candidates.splice(i, 1)
  }
  for (const { media, lang } of candidates) streams.push(toStream(media, { lang, label: target.label }))

  if (process.env.NODE_ENV !== "test") {
    // The episode WAS identified; this line says how many servers actually played.
    console.log(`[streams] ${target.slug} ep ${target.episode}: ${streams.length} links from ${jobs.length} servers` +
      (failures.length ? ` (sin enlace: ${failures.join(", ")})` : ""))
  }
  // Subtitled first, then dubs; inside each group keep JKAnime's server order.
  return streams
    .map((s, i) => ({ s, i, dub: s.name.endsWith(" SUB") ? 0 : 1 }))
    .sort((a, b) => a.dub - b.dub || a.i - b.i)
    .map(({ s }) => s)
}
