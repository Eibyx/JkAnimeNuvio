/**
 * Builds Stremio stream objects for a resolved JKAnime episode.
 * https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/stream.md
 */
const jkanime = require("../jkanime/site")
const extractors = require("../jkanime/extractors")
const { DEFAULT_UA } = require("../utils/http")

const EXTRACT_TIMEOUT_MS = Number(process.env.EXTRACT_TIMEOUT_MS) || 12000

/**
 * Why a server produced no link. Runs after the episode was already found,
 * so none of these is an identification problem.
 */
function classifyFailure(err) {
  const status = err?.status
  if (status === 404 || status === 410) return "removed"  // video deleted from that server
  if (err?.name === "BlockedError") return "blocked"
  if (/timed out|aborted|timeout/i.test(err?.message || "")) return "timeout"
  if (status >= 500) return "server-error"
  if (status) return `http-${status}`
  return "no-link"
}
exports.classifyFailure = classifyFailure

const FAILURE_TEXT = {
  removed: "video eliminado o no disponible en ese servidor (HTTP 404)",
  blocked: "bloqueado por Cloudflare",
  timeout: "sin respuesta a tiempo",
  "server-error": "error del servidor",
  "no-link": "no se encontró un enlace directo",
}

const LANG = {
  1: { tag: "SUB", text: "Japonés · subtítulos en español" },
  3: { tag: "LAT", text: "Doblaje latino" },
}
const langOf = (code) => LANG[code] || { tag: "DUB", text: "Doblaje" }

function withTimeout(promise, ms, what) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms) }),
  ]).finally(() => clearTimeout(timer))
}

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

  const settled = await Promise.allSettled(jobs.map((job) =>
    withTimeout(extractors.extract(job.embed, job.name), EXTRACT_TIMEOUT_MS, job.name)
      .then((found) => found.map((media) => ({ media, lang: job.lang })))))

  const streams = []
  const seen = new Set()
  const failures = []
  settled.forEach((r, i) => {
    if (r.status === "rejected") {
      const kind = classifyFailure(r.reason)
      failures.push(`${jobs[i].name}: ${kind}`)
      if (process.env.NODE_ENV !== "test") {
        console.warn(`[streams] ${target.slug} ep ${target.episode} · ${jobs[i].name}: ${FAILURE_TEXT[kind] || kind} (${r.reason?.message})`)
      }
      return
    }
    if (r.value.length === 0) failures.push(`${jobs[i].name}: no-link`)
    for (const { media, lang } of r.value) {
      if (seen.has(media.url)) continue
      seen.add(media.url)
      streams.push(toStream(media, { lang, label: target.label }))
    }
  })
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
