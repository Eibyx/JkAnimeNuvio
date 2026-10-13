/**
 * Maps a Stremio video id (tt…:S:E, kitsu:…, mal:…, anilist:…, tmdb:…) to a
 * JKAnime slug + episode number. It prefers returning nothing over guessing:
 * every candidate must match by title, season marker and air year.
 */
const metadata = require("./metadata")
const jkanime = require("./jkanime")
const { parseVideoId, toAbsolute } = require("./episodes")
const { parseTitle, scoreTitle, similarity, normalize } = require("./titles")

const MATCH_THRESHOLD = 0.88
const CLEAR_WIN_MARGIN = 0.03
const MAX_QUERIES = 4
const MAX_VERIFY = 3
const SERIES_FORMATS = new Set(["TV", "TV_SHORT", "ONA"])

class ResolveError extends Error {
  constructor(message) { super(message); this.name = "ResolveError" }
}
exports.ResolveError = ResolveError

const log = (...args) => { if (process.env.NODE_ENV !== "test") console.log("[resolver]", ...args) }

/** AniList entries that look like the same show and started in the given year. */
async function aniListTitlesFor(name, { year, formats }) {
  if (!year) return []
  let results = []
  try {
    results = await metadata.searchAniList(name)
  } catch (err) {
    log(`AniList unavailable: ${err.message}`)
    return []
  }
  const base = parseTitle(name).base
  return results
    .filter((m) => m && formats.has(m.format) && m.startYear && Math.abs(m.startYear - year) <= (formats.has("MOVIE") ? 1 : 0))
    .filter((m) => m.titles.some((t) => similarity(parseTitle(t).base, base) >= 0.6 || normalize(t).startsWith(base)))
    .flatMap((m) => m.titles)
}

function buildQueries(titles) {
  const queries = []
  const seen = new Set()
  for (const t of titles) {
    const q = normalize(t)
    if (q.length < 2 || seen.has(q)) continue
    seen.add(q)
    queries.push(q)
    if (queries.length >= MAX_QUERIES) break
  }
  return queries
}

async function searchCandidates(queries) {
  const settled = await Promise.allSettled(queries.map((q) => jkanime.search(q)))
  const bySlug = new Map()
  let blocked = null
  for (const r of settled) {
    if (r.status === "rejected") {
      if (r.reason?.name === "BlockedError") blocked = r.reason
      log(`JKAnime search failed: ${r.reason?.message}`)
      continue
    }
    for (const c of r.value) if (!bySlug.has(c.slug)) bySlug.set(c.slug, c)
  }
  if (bySlug.size === 0 && blocked) throw blocked
  return [...bySlug.values()]
}

const isMovieType = (type) => /pel[ií]cula|movie/i.test(type || "")
const isSpecialType = (type) => /especial|special|ova/i.test(type || "")

/**
 * Picks the JKAnime entry for a set of target titles, verifying the air year
 * against the anime page.
 * @param {Array<{title: string, season?: number}>} targets
 * @param {{expectKind: string, year?: number, requireYear?: boolean}} opts - requireYear
 *        rejects entries whose air year could not be read from JKAnime
 */
async function findEntry(targets, { expectKind, year, requireYear = false }) {
  const queries = buildQueries(targets.map((t) => t.title))
  const candidates = await searchCandidates(queries)
  const scored = candidates.map((c) => {
    if (expectKind === "series" && (isMovieType(c.type))) return { ...c, score: 0 }
    if (expectKind === "series" && isSpecialType(c.type) && !targets.some((t) => parseTitle(t.title).kind)) return { ...c, score: 0 }
    const score = Math.max(0, ...targets.map((t) => scoreTitle(c.title, t, expectKind)))
    return { ...c, score }
  }).filter((c) => c.score >= MATCH_THRESHOLD).sort((a, b) => b.score - a.score)

  log(`targets=${JSON.stringify(targets.map((t) => t.title))} year=${year} candidates=${JSON.stringify(scored.map((c) => [c.slug, +c.score.toFixed(3)]))}`)

  const verified = []
  for (const c of scored.slice(0, MAX_VERIFY)) {
    let info = null
    try {
      info = await jkanime.getAnime(c.slug)
    } catch (err) {
      if (err.name === "BlockedError") throw err
      log(`could not verify ${c.slug}: ${err.message}`)
      continue
    }
    if (requireYear && year && !info.year) continue
    if (year && info.year && Math.abs(info.year - year) > 1) continue
    if (expectKind === "series" && isMovieType(info.type)) continue
    if (expectKind === "movie" && info.episodes > 1 && !isMovieType(info.type)) continue
    verified.push({ ...c, info })
  }
  if (verified.length === 0) return null
  if (verified.length === 1) return verified[0]
  const [first, second] = verified
  if (first.score - second.score >= CLEAR_WIN_MARGIN) return first
  const exactYear = verified.filter((v) => year && v.info.year === year)
  if (exactYear.length === 1) return exactYear[0]
  throw new ResolveError(`ambiguous JKAnime match: ${verified.map((v) => v.slug).join(", ")}`)
}

async function resolveImdbSeries(imdbId, season, episode, numbering) {
  if (season === 0) throw new ResolveError("season 0 (specials/OVAs) is not mapped to JKAnime episodes")
  const meta = await metadata.getCinemeta("series", imdbId)
  let layout = meta.layout
  if (numbering === "tmdb") {
    if (!metadata.hasTmdb()) throw new ResolveError("numbering=tmdb requires TMDB_API_READ_TOKEN on the server")
    layout = await metadata.getTmdbLayout(imdbId)
  }
  const seasonYear = layout[season]?.startYear ?? (season === 1 ? meta.year : null)
  const label = `${meta.name} T${season} E${episode}`

  // 1) An entry for this very season (JKAnime usually lists each season apart).
  const seasonTitles = await aniListTitlesFor(meta.name, { year: seasonYear, formats: SERIES_FORMATS })
  const targets = [{ title: meta.name, season, canonical: true }, ...seasonTitles.map((t) => ({ title: t, season: parseTitle(t).season ?? season }))]
  // For later seasons the air year is what tells "Black Clover 2nd Season" (2026)
  // apart from TMDB's season 2 (2018, part of the 170-episode entry).
  const entry = await findEntry(targets, { expectKind: "series", year: seasonYear, requireYear: season > 1 })
  if (entry) return { slug: entry.slug, episode, title: entry.title, label, via: "season" }

  // 2) JKAnime may list several seasons as one continuous entry.
  if (season > 1) {
    const absolute = toAbsolute(layout, season, episode)
    if (!absolute) throw new ResolveError(`no layout to compute absolute episode for ${label}`)
    const firstYear = layout[1]?.startYear ?? meta.year
    const baseTitles = await aniListTitlesFor(meta.name, { year: firstYear, formats: SERIES_FORMATS })
    const baseTargets = [{ title: meta.name, season: 1, canonical: true }, ...baseTitles.map((t) => ({ title: t, season: parseTitle(t).season ?? 1 }))]
    const base = await findEntry(baseTargets, { expectKind: "series", year: firstYear })
    if (base) {
      if (base.info.episodes && absolute > base.info.episodes) {
        throw new ResolveError(`${label} = absolute episode ${absolute}, but ${base.slug} only has ${base.info.episodes} episodes`)
      }
      return { slug: base.slug, episode: absolute, title: base.title, label, via: "absolute" }
    }
  }
  throw new ResolveError(`no JKAnime entry for ${label}`)
}

async function resolveImdbMovie(imdbId) {
  const meta = await metadata.getCinemeta("movie", imdbId)
  const titles = await aniListTitlesFor(meta.name, { year: meta.year, formats: new Set(["MOVIE"]) })
  const entry = await findEntry([{ title: meta.name, canonical: true }, ...titles.map((t) => ({ title: t }))], { expectKind: "movie", year: meta.year })
  if (!entry) throw new ResolveError(`no JKAnime movie for ${meta.name} (${meta.year})`)
  return { slug: entry.slug, episode: 1, title: entry.title, label: meta.name, via: "movie" }
}

async function resolveAnimeDb(source, id, episode) {
  const entry = source === "kitsu" ? await metadata.getKitsu(id) : await metadata.getAniList(source, id)
  if (!entry.titles.length) throw new ResolveError(`${source}:${id} has no usable titles`)
  const expectKind = entry.format === "MOVIE" ? "movie" : "series"
  const found = await findEntry(entry.titles.map((t) => ({ title: t })), { expectKind, year: entry.startYear })
  if (!found) throw new ResolveError(`no JKAnime entry for ${source}:${id} (${entry.titles[0]})`)
  const ep = episode ?? 1
  return { slug: found.slug, episode: ep, title: found.title, label: `${entry.titles[0]} E${ep}`, via: source }
}

/**
 * @param {string} type - Stremio type (series, movie, anime)
 * @param {string} rawId - Stremio video id
 * @param {{numbering?: "cinemeta"|"tmdb"}} config
 * @returns {Promise<{slug, episode, title, label, via}>}
 */
exports.resolve = async function resolve(type, rawId, config = {}) {
  const id = parseVideoId(rawId)
  if (!id) throw new ResolveError(`unsupported id: ${rawId}`)
  const numbering = config.numbering === "tmdb" ? "tmdb" : "cinemeta"

  if (id.source === "imdb") {
    if (id.season !== undefined) return resolveImdbSeries(id.id, id.season, id.episode, numbering)
    if (type === "series") throw new ResolveError("series request without season/episode")
    return resolveImdbMovie(id.id)
  }
  if (id.source === "tmdb") {
    // tmdb:ID:S:E comes from TMDB-based catalogs, so it already uses TMDB numbering.
    if (!metadata.hasTmdb()) throw new ResolveError("tmdb ids require TMDB_API_READ_TOKEN on the server")
    const imdb = await metadata.getImdbFromTmdb(id.id, id.season !== undefined ? "series" : "movie")
    if (id.season !== undefined) return resolveImdbSeries(imdb, id.season, id.episode, "tmdb")
    return resolveImdbMovie(imdb)
  }
  return resolveAnimeDb(id.source, id.id, id.episode)
}
