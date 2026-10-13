/**
 * Maps a Stremio video id (tt…:S:E, tmdb:…, tvdb:…, kitsu:…, mal:…, anilist:…)
 * to a JKAnime slug + episode number. It prefers returning nothing over
 * guessing: every candidate must match by title, season marker and air year.
 */
const identityApi = require("./identity")
const anilist = require("./providers/anilist")
const kitsu = require("./providers/kitsu")
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

/**
 * AniList entries that look like the same show and started in the given
 * year (searched by each known name, including native titles).
 * @param {string[]} names
 * @param {Array<object>} known - AniList entries already verified for this show
 */
async function aniListTitlesFor(names, { year, formats, known = [] }) {
  if (!year) return []
  const byId = new Map(known.map((m) => [m.id, m]))
  const settled = await Promise.allSettled(names.slice(0, 3).map((n) => anilist.search(n)))
  for (const r of settled) {
    if (r.status === "rejected") { log(`AniList unavailable: ${r.reason?.message}`); continue }
    for (const m of r.value) if (m && !byId.has(m.id)) byId.set(m.id, m)
  }
  const baseNames = names.map((n) => parseTitle(n).base).filter(Boolean)
  const verified = new Set(known.map((m) => m.id))
  return [...byId.values()]
    .filter((m) => m && formats.has(m.format) && m.startYear && Math.abs(m.startYear - year) <= (formats.has("MOVIE") ? 1 : 0))
    .filter((m) => verified.has(m.id) || m.titles.some((t) => baseNames.some((base) =>
      similarity(parseTitle(t).base, base) >= 0.6 || normalize(t).startsWith(base))))
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

async function identityOrFail(seed, type, config) {
  const identity = await identityApi.identify(seed, type, { wantTvdb: String(config.numbering || "").startsWith("tvdb") })
  if (!identity) {
    const which = identityApi.identityProviders().join(", ") || "none"
    throw new ResolveError(`no metadata provider recognises ${JSON.stringify(seed)} (enabled: ${which})`)
  }
  log(`identity ${JSON.stringify(seed)}: ${identity.name} (${identity.year}) via ${identity.sources.join("+")} | ${identity.evidence.join(" | ")}`)
  return identity
}

async function resolveSeries(seed, season, episode, config) {
  if (season === 0) throw new ResolveError("season 0 (specials/OVAs) is not mapped to JKAnime episodes")
  const identity = await identityOrFail(seed, "series", config)
  let picked
  try {
    picked = await identityApi.layoutFor(identity, config.numbering || "auto")
  } catch (err) {
    throw new ResolveError(err.message)
  }
  const { layout } = picked
  const mapping = config.mapping || "auto"
  const seasonYear = layout[season]?.startYear ?? (season === 1 ? identity.year : null)
  const label = `${identity.name} T${season} E${episode}`
  const canonical = (s) => identity.names.map((n) => ({ title: n, season: s, canonical: true }))
  // Provider aliases are weaker than names: matched with markers, still year-verified.
  const aliases = (s) => identity.aliases.map((a) => ({ title: a, season: parseTitle(a).season ?? s }))
  const anilistFor = (year) => aniListTitlesFor(identity.searchNames, {
    year, formats: SERIES_FORMATS, known: identity.anilist.filter((m) => m.startYear === year),
  })

  // 1) An entry for this very season (JKAnime usually lists each season apart).
  // For later seasons the air year is the only safe way to tell entries apart,
  // so without it (season unknown to this numbering) this step is skipped.
  if (mapping !== "absolute" && (season === 1 || seasonYear)) {
    const seasonTitles = await anilistFor(seasonYear)
    const targets = [...canonical(season), ...seasonTitles.map((t) => ({ title: t, season: parseTitle(t).season ?? season })), ...aliases(season)]
    // For later seasons the air year is what tells "Black Clover 2nd Season" (2026)
    // apart from TMDB's season 2 (2018, part of the 170-episode entry).
    const entry = await findEntry(targets, { expectKind: "series", year: seasonYear, requireYear: season > 1 })
    if (entry) return { slug: entry.slug, episode, title: entry.title, label, via: `season/${picked.numbering}` }
  }

  // 2) JKAnime may list several seasons as one continuous entry.
  if (mapping !== "season" && (season > 1 || mapping === "absolute")) {
    const absolute = toAbsolute(layout, season, episode)
    if (!absolute) throw new ResolveError(`no ${picked.numbering} layout to compute absolute episode for ${label}`)
    const firstYear = layout[1]?.startYear ?? identity.year
    const baseTitles = await anilistFor(firstYear)
    const baseTargets = [...canonical(1), ...baseTitles.map((t) => ({ title: t, season: parseTitle(t).season ?? 1 })), ...aliases(1)]
    const base = await findEntry(baseTargets, { expectKind: "series", year: firstYear })
    if (base) {
      if (base.info.episodes && absolute > base.info.episodes) {
        throw new ResolveError(`${label} = absolute episode ${absolute}, but ${base.slug} only has ${base.info.episodes} episodes`)
      }
      return { slug: base.slug, episode: absolute, title: base.title, label, via: `absolute/${picked.numbering}` }
    }
  }
  throw new ResolveError(`no JKAnime entry for ${label}`)
}

async function resolveMovie(seed, config) {
  const identity = await identityOrFail(seed, "movie", config)
  const titles = await aniListTitlesFor(identity.searchNames, { year: identity.year, formats: new Set(["MOVIE"]) })
  const targets = [...identity.names.map((n) => ({ title: n, canonical: true })), ...titles.map((t) => ({ title: t })), ...identity.aliases.map((a) => ({ title: a }))]
  const entry = await findEntry(targets, { expectKind: "movie", year: identity.year })
  if (!entry) throw new ResolveError(`no JKAnime movie for ${identity.name} (${identity.year})`)
  return { slug: entry.slug, episode: 1, title: entry.title, label: identity.name, via: "movie" }
}

async function resolveAnimeDb(source, id, episode) {
  const entry = source === "kitsu" ? await kitsu.getById(id) : await anilist.getById(source, id)
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
 * @param {{numbering?: string, mapping?: "auto"|"season"|"absolute"}} config
 *        numbering: auto (Cinemeta, else TMDB, else TVDB), cinemeta, tmdb, tvdb, tvdb-<order>
 * @returns {Promise<{slug, episode, title, label, via}>}
 */
exports.resolve = async function resolve(type, rawId, config = {}) {
  const id = parseVideoId(rawId)
  if (!id) throw new ResolveError(`unsupported id: ${rawId}`)

  if (id.source === "imdb" || id.source === "tmdb" || id.source === "tvdb") {
    const seed = { [id.source]: id.id }
    let cfg = config
    // tmdb:/tvdb: ids come from TMDB/TVDB catalogs, so they use that numbering unless told otherwise.
    if (id.source !== "imdb" && (!config.numbering || config.numbering === "auto")) cfg = { ...config, numbering: id.source }
    if (id.season !== undefined) return resolveSeries(seed, id.season, id.episode, cfg)
    if (type === "series") throw new ResolveError("series request without season/episode")
    if (id.source === "tvdb") throw new ResolveError("tvdb movie ids are not supported")
    return resolveMovie(seed, cfg)
  }
  return resolveAnimeDb(id.source, id.id, id.episode)
}
