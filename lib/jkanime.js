/**
 * JKAnime scraping: search, anime page and episode page (server list).
 * The HTML selectors follow the structure used by the upstream addon; JKAnime
 * can change it at any time, so every parser fails closed (empty result).
 */
const cheerio = require("cheerio")
const { request, fetchText, safeUrl } = require("./http")
const { TTLCache } = require("./cache")

const JKANIME_BASE = (process.env.JKANIME_BASE || "https://jkanime.net").replace(/\/+$/, "")
exports.JKANIME_BASE = JKANIME_BASE
const JK_HOST = new URL(JKANIME_BASE).hostname

const searchCache = new TTLCache({ ttlMs: 60 * 60 * 1000 })
const animeCache = new TTLCache({ ttlMs: 6 * 60 * 60 * 1000 })
const episodeCache = new TTLCache({ ttlMs: 10 * 60 * 1000 })
exports.caches = [searchCache, animeCache, episodeCache]

const RESERVED_PATHS = new Set(["buscar", "directorio", "genero", "letra", "horario", "top", "ajax", "jkplayer", "tipo", "user", "login", "registro", "assets", "cdn-cgi"])

/** Extracts the JKAnime slug from an absolute or relative anime/episode link. */
function slugFromHref(href) {
  if (typeof href !== "string" || !href.trim()) return null
  const url = safeUrl(href, JKANIME_BASE)
  if (!url || (url.hostname !== JK_HOST && !url.hostname.endsWith(".jkanime.net") && url.hostname !== "jkanime.net")) return null
  const first = url.pathname.split("/").filter(Boolean)[0]
  if (!first || RESERVED_PATHS.has(first.toLowerCase()) || !/^[a-z0-9][a-z0-9-]*$/i.test(first)) return null
  return first.toLowerCase()
}
exports.slugFromHref = slugFromHref

function parseSearch(html) {
  const $ = cheerio.load(html)
  const results = []
  const seen = new Set()
  $(".anime__item").each((_, el) => {
    const $el = $(el)
    const link = $el.find("a[href]").filter((_, a) => slugFromHref($(a).attr("href"))).first()
    const slug = slugFromHref(link.attr("href"))
    if (!slug || seen.has(slug)) return
    const title = ($el.find("h5").first().text() || link.attr("title") || "").replace(/\s+/g, " ").trim()
    if (!title) return
    seen.add(slug)
    const type = $el.find("li.anime").first().text().trim() ||
      $el.find(".anime__item__text ul li").first().text().trim() || null
    results.push({ title, slug, type })
  })
  return results
}
exports.parseSearch = parseSearch

/** @returns {Promise<Array<{title, slug, type}>>} */
exports.search = (query) => {
  const q = String(query || "").trim()
  if (!q) return Promise.resolve([])
  return searchCache.wrap(q.toLowerCase(), async () => {
    const html = await fetchText(`${JKANIME_BASE}/buscar/${encodeURIComponent(q)}`, { referer: `${JKANIME_BASE}/` })
    return parseSearch(html)
  })
}

function parseAnimePage(html, slug) {
  const $ = cheerio.load(html)
  const details = $(".anime__details__content").first()
  const scope = details.length ? details : $("body")
  const text = scope.text().replace(/\s+/g, " ")
  const title = scope.find(".anime_info h3, .anime__details__title h3").first().text().trim() || $("h3").first().text().trim()
  const typeText = scope.find("li[rel=tipo]").first().text().replace(/Tipo:/i, "").trim() ||
    (text.match(/Tipo:\s*([A-Za-zÁÉÍÓÚáéíóú]+)/)?.[1] ?? null)
  const emitted = text.match(/Emitido:?\s*([^|]*?\b(19|20)\d{2})/i)
  const year = emitted ? Number(emitted[0].match(/(19|20)\d{2}/)[0]) : null
  const episodes = Number(text.match(/Episodios:?\s*(\d+)/i)?.[1]) || null
  const status = /En emisi[oó]n/i.test(text) ? "airing" : (/Concluido|Finalizado/i.test(text) ? "finished" : null)
  return {
    slug,
    title,
    type: typeText || null,
    year,
    episodes,
    status,
    animeId: $("#guardar-anime").first().attr("data-anime") || null,
    csrf: $("meta[name=csrf-token]").attr("content") || null,
  }
}
exports.parseAnimePage = parseAnimePage

/** Anime page details: type, first air year and episode count. */
exports.getAnime = (slug) => animeCache.wrap(slug, async () => {
  const pageUrl = `${JKANIME_BASE}/${slug}/`
  const html = await fetchText(pageUrl, { referer: `${JKANIME_BASE}/` })
  const info = parseAnimePage(html, slug)
  if (!info.episodes && info.animeId && info.csrf) {
    // Same endpoint the site uses to page through the episode list.
    try {
      const { text } = await request(`${JKANIME_BASE}/ajax/episodes/${encodeURIComponent(info.animeId)}/1`, {
        method: "POST",
        referer: pageUrl,
        headers: {
          Accept: "application/json, text/javascript, */*; q=0.01",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: `_token=${encodeURIComponent(info.csrf)}`,
      })
      const total = Number(JSON.parse(text)?.total)
      if (total > 0) info.episodes = total
    } catch (err) {
      console.warn(`[jkanime] episode count unavailable for ${slug}: ${err.message}`)
    }
  }
  delete info.csrf
  return info
})

/** Finds the JSON array literal assigned to `var name = [...]` in a script. */
function extractJsArray(source, name) {
  const re = new RegExp(`(?:var|let|const)\\s+${name}\\s*=\\s*\\[`)
  const m = re.exec(source)
  if (!m) return null
  const start = m.index + m[0].length - 1
  let depth = 0
  let quote = null
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (quote) {
      if (ch === "\\") i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === "[") depth++
    else if (ch === "]" && --depth === 0) return source.slice(start, i + 1)
  }
  return null
}
exports.extractJsArray = extractJsArray

function decodeRemote(remote) {
  if (typeof remote !== "string" || !remote) return null
  if (/^https?:\/\//i.test(remote)) return remote.trim()
  try {
    const decoded = Buffer.from(remote, "base64").toString("utf8").trim()
    return /^https?:\/\//i.test(decoded) ? decoded : null
  } catch {
    return null
  }
}

/**
 * Parses an episode page.
 * servers: entries of `var servers = [...]` ({remote: base64(embed), server, lang})
 * players: JKAnime's own iframes (`video[n] = '<iframe src=...>'`)
 * lang 1 = Japanese audio with Spanish subs, 3 = Latin American Spanish dub.
 */
function parseEpisodePage(html) {
  const $ = cheerio.load(html)
  const scripts = $("script").map((_, el) => $(el).html() || "").get().join("\n")
  const servers = []
  const raw = extractJsArray(scripts, "servers")
  if (raw) {
    let list = []
    try { list = JSON.parse(raw) } catch { list = [] }
    for (const s of Array.isArray(list) ? list : []) {
      const embed = decodeRemote(s?.remote)
      if (!embed || !safeUrl(embed)) continue
      servers.push({ name: String(s.server || "").trim() || new URL(embed).hostname, embed, lang: Number(s.lang) || 1 })
    }
  }
  const players = []
  const playerRe = /video\[\d+\]\s*=\s*['"]<iframe[^>]+src=\\?["']([^"'\\]+)\\?["']/gi
  let m
  while ((m = playerRe.exec(scripts))) {
    const url = safeUrl(m[1].replace(/&amp;/g, "&"), JKANIME_BASE)
    if (url && !players.includes(url.href)) players.push(url.href)
  }
  const heading = $("h1").first().text() + " " + $(".breadcrumb, .episode__title, .anime__details__title").text()
  const number = Number(heading.match(/episodio\s*(\d+)/i)?.[1]) || null
  const title = ($("div.video_i > a").first().text() || $(".breadcrumb a").last().text() || "").trim() || null
  return { title, number, servers, players }
}
exports.parseEpisodePage = parseEpisodePage

/**
 * Loads an episode page and checks that JKAnime really served that episode
 * (missing episodes redirect to the anime page instead of failing).
 */
exports.getEpisode = (slug, episode) => episodeCache.wrap(`${slug}:${episode}`, async () => {
  const { text, url } = await request(`${JKANIME_BASE}/${slug}/${episode}/`, { referer: `${JKANIME_BASE}/${slug}/` })
  const path = new URL(url).pathname.split("/").filter(Boolean)
  if (path[0]?.toLowerCase() !== slug || path[1] !== String(episode)) {
    throw new Error(`JKAnime redirected ${slug}/${episode} to ${url}`)
  }
  const page = parseEpisodePage(text)
  if (page.number && page.number !== episode) throw new Error(`JKAnime served episode ${page.number} for ${slug}/${episode}`)
  return page
})
