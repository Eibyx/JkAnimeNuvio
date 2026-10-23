/**
 * JKAnime scraping: search, anime page and episode page (server list).
 * The HTML selectors follow the structure used by the upstream addon; JKAnime
 * can change it at any time, so every parser fails closed (empty result).
 */
const cheerio = require("cheerio")
const { request, safeUrl } = require("../utils/http")
const { TTLCache } = require("../utils/cache")
const { AppError } = require("../utils/errors")
const { limiter } = require("../utils/limiter")

const JKANIME_BASE = (process.env.JKANIME_BASE || "https://jkanime.net").replace(/\/+$/, "")
exports.JKANIME_BASE = JKANIME_BASE
const JK_HOST = new URL(JKANIME_BASE).hostname

const MIN = 60 * 1000
// Search: a hit is stable for an hour; "no results" may change soon (new
// season added), so it is kept briefly. Errors and unreadable pages are not kept.
const SEARCH_TTL = { hit: 60 * MIN, empty: 10 * MIN }
// Anime page: finished shows rarely change; airing/upcoming ones gain episodes.
const ANIME_TTL = { stable: 6 * 60 * MIN, airing: 30 * MIN }
const searchCache = new TTLCache({ ttlMs: SEARCH_TTL.hit, name: "jkanimeSearch" })
const animeCache = new TTLCache({ ttlMs: ANIME_TTL.stable, name: "jkanimeAnime" })
const episodeCache = new TTLCache({ ttlMs: 10 * MIN, name: "jkanimeEpisode" })
exports.caches = [searchCache, animeCache, episodeCache]
exports.TTL = { SEARCH_TTL, ANIME_TTL }

// Requests to JKAnime in flight at once, across all Stremio requests.
const jkLimit = limiter(Number(process.env.JK_CONCURRENCY) || 3)
const jkRequest = (url, opts) => jkLimit(() => request(url, opts))

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

/**
 * Parses a search page. A page with no results still has the results
 * container ("row page_directorio" / "Resultados del busqueda" in the HTML
 * archived 2026-09); without it the layout changed and [] would be a lie.
 * @throws {AppError} PARSER_CHANGED
 */
function parseSearch(html) {
  const $ = cheerio.load(html)
  const isSearchPage = $(".anime__item, .page_directorio").length > 0 || /Resultados?\s+del?\s+b[uú]squeda/i.test($("h4, h2, h1").text())
  if (!isSearchPage) throw new AppError("PARSER_CHANGED", "JKAnime search page has no results container (layout changed?)")
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
    const { text } = await jkRequest(`${JKANIME_BASE}/buscar/${encodeURIComponent(q)}`, { referer: `${JKANIME_BASE}/` })
    return parseSearch(text)
  }, (results) => (results.length ? SEARCH_TTL.hit : SEARCH_TTL.empty))
}

/**
 * Parses an anime page (structure checked against pages archived 2026-06/09).
 * @throws {AppError} PARSER_CHANGED when the details block is missing
 */
function parseAnimePage(html, slug) {
  const $ = cheerio.load(html)
  const details = $(".anime__details__content").first()
  if (!details.length) throw new AppError("PARSER_CHANGED", `JKAnime page of ${slug} has no details block (layout changed?)`)
  const scope = details
  const text = scope.text().replace(/\s+/g, " ")
  const heading = scope.find(".anime_info h3, .anime__details__title h3").first()
  const title = heading.text().trim()
  // The line under the title is an alternative name ("Aoashi Season 2", "The Ramparts of Ice").
  const altTitle = heading.next("span").text().replace(/\s+/g, " ").trim() || null
  const typeText = scope.find("li[rel=tipo]").first().text().replace(/Tipo:/i, "").trim() ||
    (text.match(/Tipo:\s*([A-Za-zÁÉÍÓÚáéíóú]+)/)?.[1] ?? null)
  const emitted = text.match(/Emitido:?\s*([^|]*?\b(19|20)\d{2})/i)
  const year = emitted ? Number(emitted[0].match(/(19|20)\d{2}/)[0]) : null
  const episodes = Number(text.match(/Episodios:?\s*(\d+)/i)?.[1]) || null
  const statusClass = scope.find(".enemision").first().attr("class") || ""
  const status = /\bcurrently\b/.test(statusClass) || /En emisi[oó]n/i.test(text) ? "airing"
    : /\bnotyet\b/.test(statusClass) || /Por estrenar/i.test(text) ? "upcoming"
      : /\bfinished\b/.test(statusClass) || /Concluido|Finalizado/i.test(text) ? "finished" : null
  if (!title) throw new AppError("PARSER_CHANGED", `JKAnime page of ${slug} has no title (layout changed?)`)
  return {
    slug,
    title,
    altTitle: altTitle && altTitle !== title ? altTitle : null,
    type: typeText || null,
    year,
    episodes,
    status,
    animeId: $("#guardar-anime").first().attr("data-anime") || null,
    csrf: $("meta[name=csrf-token]").attr("content") || null,
  }
}
exports.parseAnimePage = parseAnimePage

/**
 * Cookies the page just set, as a Cookie header for a follow-up request to
 * the same site (what a browser does). Never stored beyond that request.
 */
function sessionCookies(headers) {
  const list = typeof headers?.getSetCookie === "function" ? headers.getSetCookie() : []
  const pairs = list.map((c) => String(c).split(";")[0].trim()).filter((c) => /^[\w.-]+=[^;\s]*$/.test(c))
  return pairs.length ? pairs.join("; ") : null
}
exports.sessionCookies = sessionCookies

/** Anime page details: type, first air year, episode count and status. */
exports.getAnime = (slug) => animeCache.wrap(slug, async () => {
  const pageUrl = `${JKANIME_BASE}/${slug}/`
  const page = await jkRequest(pageUrl, { referer: `${JKANIME_BASE}/` })
  const info = parseAnimePage(page.text, slug)
  if (!info.episodes && info.status !== "upcoming" && info.animeId && info.csrf) {
    // Same endpoint the site's own script uses to page through the episodes.
    // JKAnime is a Laravel site: the CSRF token is tied to the session cookie
    // the browser sends along; without it the answer is HTTP 419.
    const cookie = sessionCookies(page.headers)
    try {
      const { text } = await jkRequest(`${JKANIME_BASE}/ajax/episodes/${encodeURIComponent(info.animeId)}/1`, {
        method: "POST",
        referer: pageUrl,
        headers: {
          Accept: "application/json, text/javascript, */*; q=0.01",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: `_token=${encodeURIComponent(info.csrf)}`,
      })
      const total = Number(JSON.parse(text)?.total)
      if (total > 0) info.episodes = total
    } catch (err) {
      if (process.env.NODE_ENV !== "test") console.warn(`[jkanime] episode count unavailable for ${slug}: ${err.code || err.message}`)
    }
  }
  delete info.csrf
  return info
}, (info) => (info.status === "finished" ? ANIME_TTL.stable : ANIME_TTL.airing))

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
 * Parses an episode page (adapted from
 * https://github.com/ahmedrangel/animeflv-api getEpisodeLinks.ts via the upstream addon).
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
  return { title, number, servers, players, hasServerList: raw !== null }
}
exports.parseEpisodePage = parseEpisodePage

/**
 * Loads an episode page and checks that JKAnime really served that episode
 * (missing episodes redirect to the anime page instead of failing).
 */
exports.getEpisode = (slug, episode) => episodeCache.wrap(`${slug}:${episode}`, async () => {
  let page
  try {
    page = await jkRequest(`${JKANIME_BASE}/${slug}/${episode}/`, { referer: `${JKANIME_BASE}/${slug}/` })
  } catch (err) {
    if (err.status === 404) throw new AppError("EPISODE_NOT_FOUND", `JKAnime has no page ${slug}/${episode} (HTTP 404)`)
    throw err
  }
  const path = new URL(page.url).pathname.split("/").filter(Boolean)
  if (path[0]?.toLowerCase() !== slug || path[1] !== String(episode)) {
    // Missing episodes redirect to the anime page instead of failing.
    throw new AppError("EPISODE_NOT_FOUND", `JKAnime redirected ${slug}/${episode} to /${path.join("/")}/ (episode not available)`)
  }
  const parsed = parseEpisodePage(page.text)
  if (parsed.number && parsed.number !== episode) throw new AppError("EPISODE_NOT_FOUND", `JKAnime served episode ${parsed.number} for ${slug}/${episode}`)
  if (!parsed.number && !parsed.hasServerList && parsed.players.length === 0) {
    throw new AppError("PARSER_CHANGED", `JKAnime episode page ${slug}/${episode} has neither a heading nor a server list (layout changed?)`)
  }
  return parsed
})
