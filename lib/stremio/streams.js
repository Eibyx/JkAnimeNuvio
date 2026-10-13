/**
 * Builds Stremio stream objects for a resolved JKAnime episode.
 * https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/stream.md
 */
const jkanime = require("../jkanime/site")
const extractors = require("../jkanime/extractors")
const { DEFAULT_UA } = require("../utils/http")

const EXTRACT_TIMEOUT_MS = Number(process.env.EXTRACT_TIMEOUT_MS) || 12000

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
  settled.forEach((r, i) => {
    if (r.status === "rejected") {
      if (process.env.NODE_ENV !== "test") console.warn(`[streams] ${jobs[i].name} failed: ${r.reason?.message}`)
      return
    }
    for (const { media, lang } of r.value) {
      if (seen.has(media.url)) continue
      seen.add(media.url)
      streams.push(toStream(media, { lang, label: target.label }))
    }
  })
  // Subtitled first, then dubs; inside each group keep JKAnime's server order.
  return streams
    .map((s, i) => ({ s, i, dub: s.name.endsWith(" SUB") ? 0 : 1 }))
    .sort((a, b) => a.dub - b.dub || a.i - b.i)
    .map(({ s }) => s)
}
