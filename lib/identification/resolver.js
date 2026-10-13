/**
 * Maps a Stremio video id (tt…:S:E, tmdb:…, tvdb:…, kitsu:…, mal:…, anilist:…)
 * to a JKAnime slug + episode number. It prefers returning nothing over
 * guessing: every candidate must match by title, season marker, format and
 * a VERIFIED air year (read from the JKAnime page). Showing no streams is
 * better than playing an episode of another anime.
 */
const identityApi = require("./identity")
const anilist = require("../providers/anilist")
const kitsu = require("../providers/kitsu")
const relations = require("../providers/relations")
const jkanime = require("../jkanime/site")
const { parseVideoId, toAbsolute } = require("./episodes")
const { parseTitle, scoreTitle, similarity, normalize, fold, isLatinTitle, mainName, contentWords } = require("./titles")
const { buildSearchPlan } = require("./queries")
const { limiter } = require("../utils/limiter")
const { trace } = require("../utils/context")

const MATCH_THRESHOLD = 0.88
// Without a year to verify, only an exact title is enough.
const EXACT_THRESHOLD = 0.97
const CLEAR_WIN_MARGIN = 0.03
const MAX_VERIFY = 6
const SERIES_FORMATS = new Set(["TV", "TV_SHORT", "ONA"])
const OVA_FORMATS = new Set(["OVA", "SPECIAL"])

/** Search limits (environment overrides), read per request. */
const searchLimits = () => ({
  maxQueries: Number(process.env.JK_MAX_QUERIES) || 8,
  concurrency: Number(process.env.JK_SEARCH_CONCURRENCY) || 2,
  budgetMs: Number(process.env.JK_SEARCH_BUDGET_MS) || 10000,
})

/**
 * code: ANIME_NOT_FOUND, AMBIGUOUS, EPISODE_NOT_FOUND, IDENTITY_FAILED,
 * UNSUPPORTED_ID, NUMBERING_UNAVAILABLE
 */
class ResolveError extends Error {
  constructor(message, code = "ANIME_NOT_FOUND") { super(message); this.name = "ResolveError"; this.code = code }
}
exports.ResolveError = ResolveError

const log = (...args) => { if (process.env.NODE_ENV !== "test") console.log("[resolver]", ...args) }

/**
 * AniList entries that look like the same show and started in the given
 * year (searched by each known name, including native titles).
 * @param {string[]} names
 * @param {Array<object>} known - AniList entries already verified for this show
 */
async function aniListEntriesFor(names, { year, formats, known = [] }) {
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
}

/** Season marker an AniList entry carries in its titles ("2nd Season" -> 2), or null. */
const seasonMarkerOf = (titles) => titles.map((t) => parseTitle(t).season).find((n) => n) ?? null

/**
 * Keeps the AniList entries that describe the requested season. Two seasons
 * can start in the same year (Koori no Jouheki: spring and autumn 2026), so
 * the year alone does not tell them apart: an entry marked for another
 * season is dropped, and an unmarked one only stands for season 1 unless no
 * entry of that year is marked for the requested season.
 */
function entriesForSeason(entries, season) {
  const markedForSeason = entries.some((m) => seasonMarkerOf(m.titles) === season)
  return entries.filter((m) => {
    const marker = seasonMarkerOf(m.titles)
    if (marker) return marker === season
    return season === 1 || !markedForSeason
  })
}

const isMovieType = (type) => /pel[ií]cula|movie/i.test(type || "")
const isSpecialType = (type) => /especial|special|ova/i.test(type || "")

/**
 * How a JKAnime title matches the targets.
 * full: the whole title matches (scoreTitle: season/part/kind aware).
 * partial: only the main name matches ("Saijo no Osewa" for "Saijo no Osewa:
 *   Takane no Hanadarake na ..."), with identical season/part/kind markers
 *   on the full titles. Partial matches need an exact verified year.
 * @returns {{score: number, kind: "full"|"partial"|null, target?: object}}
 */
function matchOf(title, targets, expectKind) {
  let best = { score: 0, kind: null }
  for (const t of targets) {
    const score = scoreTitle(title, t, expectKind)
    if (score > best.score || (score === best.score && best.kind !== "full" && score > 0)) best = { score, kind: "full", target: t }
  }
  if (best.score >= MATCH_THRESHOLD) return best
  const c = parseTitle(title)
  const cMain = mainName(title)
  for (const t of targets) {
    const tp = parseTitle(t.title)
    const tMain = mainName(t.title)
    // One side must be the bare main name of the other ("Saijo no Osewa" for
    // "Saijo no Osewa: Takane no ..."). Two different subtitles under the same
    // main name are different arcs ("Kimetsu no Yaiba: Yuukaku-hen" is not
    // "Kimetsu no Yaiba: Mugen Ressha-hen").
    const pairs = [[cMain ? null : c.normalized, tMain], [cMain, tMain ? null : tp.normalized]].filter(([a, b]) => a && b)
    if (!pairs.length) continue
    const wanted = t.canonical ? (t.season ?? 1) : (tp.season ?? t.season ?? 1)
    if ((c.season ?? 1) !== wanted || (c.part || 1) !== (tp.part || 1) || c.kind !== tp.kind || c.finalSeason !== tp.finalSeason) continue
    for (const [a, b] of pairs) {
      const shorter = a.length <= b.length ? a : b
      if (contentWords(shorter).length < 2) continue
      const score = similarity(fold(parseTitle(a).base), fold(parseTitle(b).base))
      if (score >= MATCH_THRESHOLD && score > (best.kind === "partial" ? best.score : 0)) best = { score, kind: "partial", target: t }
    }
  }
  return best.kind === "partial" ? best : { score: best.score, kind: null }
}

/**
 * Checks a candidate against its JKAnime page.
 * @returns {Promise<{ok: boolean, reason?: string, kind?: string, info?: object}>}
 */
async function verifyCandidate(c, targets, { expectKind, year, maxEpisodes }) {
  let info
  try {
    info = await jkanime.getAnime(c.slug)
  } catch (err) {
    if (err.name === "BlockedError") throw err
    return { ok: false, reason: `page unavailable (${err.code || err.message})` }
  }
  // The page title and its alternative name may match better than the search title.
  let kind = c.kind
  let score = c.score
  for (const t of [info.title, info.altTitle].filter(Boolean)) {
    const m = matchOf(t, targets, expectKind)
    if (m.kind === "full" && (kind !== "full" || m.score > score)) { kind = "full"; score = Math.max(score, m.score) }
  }
  const type = info.type || c.type
  if (expectKind === "series" && isMovieType(type)) return { ok: false, reason: `JKAnime type ${type}` }
  if (expectKind === "series" && isSpecialType(type) && !targets.some((t) => parseTitle(t.title).kind)) return { ok: false, reason: `JKAnime type ${type}` }
  if (expectKind === "movie" && info.episodes > 1 && !isMovieType(type)) return { ok: false, reason: `JKAnime type ${type} with ${info.episodes} episodes` }
  if (expectKind === "ova" && type && !isSpecialType(type)) return { ok: false, reason: `JKAnime type ${type}, expected OVA/special` }

  const tagYear = parseTitle(c.title).year ?? parseTitle(info.title).year
  if (year) {
    if (tagYear && Math.abs(tagYear - year) > 1) return { ok: false, reason: `title says ${tagYear}, expected ${year}` }
    if (!info.year) return { ok: false, reason: `air year not shown on JKAnime (expected ${year}): cannot verify` }
    if (Math.abs(info.year - year) > 1) return { ok: false, reason: `aired ${info.year}, expected ${year}` }
    if (kind === "partial" && info.year !== year) return { ok: false, reason: `partial title match needs the exact year (${info.year} vs ${year})` }
  } else {
    if (kind === "partial") return { ok: false, reason: "partial title match and no year to verify" }
    if (score < EXACT_THRESHOLD) return { ok: false, reason: `no year to verify and the title is not exact (${score.toFixed(2)})` }
  }
  // A JKAnime entry may merge several cours of the same title (numbering from 1
  // still coincides for the first one). On a partial title match, though, a
  // longer entry is more likely another cut of the franchise: rejected.
  if (kind === "partial" && maxEpisodes && info.status === "finished" && info.episodes > maxEpisodes) {
    return { ok: false, reason: `partial title match, and JKAnime has ${info.episodes} episodes where the requested entry has ${maxEpisodes}` }
  }
  return { ok: true, kind, score, info }
}

/** Picks one entry or throws AMBIGUOUS. */
function choose(list, year) {
  if (list.length === 1) return list[0]
  const sorted = [...list].sort((a, b) => b.score - a.score)
  const [first, second] = sorted
  if (first.score - second.score >= CLEAR_WIN_MARGIN) return first
  const exactYear = sorted.filter((v) => year && v.info.year === year)
  if (exactYear.length === 1) return exactYear[0]
  throw new ResolveError(`ambiguous JKAnime match: ${sorted.map((v) => v.slug).join(", ")}`, "AMBIGUOUS")
}

/**
 * Finds the JKAnime entry for a set of target titles with a staged search
 * (see queries.js): stops at the first stage that yields a verified entry.
 * @param {Array<{title: string, season?: number, canonical?: boolean, primary?: boolean}>} targets
 * @param {{expectKind: "series"|"movie"|"ova", year?: number, maxEpisodes?: number}} opts
 * @returns {Promise<null|{slug, title, score, kind, evidence, info}>}
 */
async function findEntry(targets, opts) {
  const { expectKind } = opts
  const limits = searchLimits()
  const plan = buildSearchPlan({
    primary: targets.filter((t) => t.canonical || t.primary).map((t) => t.title),
    alternatives: targets.filter((t) => !t.canonical && !t.primary).map((t) => t.title),
  })
  const started = Date.now()
  const runQuery = limiter(limits.concurrency)
  const candidates = new Map()
  const verified = new Map()
  const errors = []
  let sent = 0

  for (const { stage, queries } of plan) {
    const room = Math.max(0, limits.maxQueries - sent)
    const batch = queries.slice(0, room)
    if (!batch.length || Date.now() - started > limits.budgetMs) {
      trace("search-limit", { step: stage, skipped: queries.length, reason: !batch.length ? "max queries" : "time budget" })
      break
    }
    sent += batch.length
    // A Cloudflare challenge will not go away with more queries: stop at the first one.
    let blocked = null
    const settled = await Promise.allSettled(batch.map((q) => runQuery(() => {
      if (blocked) throw blocked
      return jkanime.search(q).catch((err) => { if (err?.name === "BlockedError") blocked = err; throw err })
    })))
    settled.forEach((r, i) => {
      if (r.status === "rejected") {
        if (r.reason === blocked && errors.includes(blocked)) return
        errors.push(r.reason)
        trace("search", { step: stage, query: batch[i], error: r.reason?.code || r.reason?.message })
        log(`JKAnime search "${batch[i]}" failed: ${r.reason?.code || r.reason?.message}`)
        return
      }
      trace("search", { step: stage, query: batch[i], results: r.value.length })
      for (const c of r.value) {
        if (candidates.has(c.slug)) continue
        let m = matchOf(c.title, targets, expectKind)
        if (expectKind === "series" && isMovieType(c.type)) m = { score: 0, kind: null, rejected: `JKAnime type ${c.type}` }
        candidates.set(c.slug, { ...c, ...m, stage })
      }
    })

    if (blocked) throw blocked
    const pending = [...candidates.values()]
      .filter((c) => c.kind && !verified.has(c.slug))
      .sort((a, b) => (a.kind === b.kind ? b.score - a.score : a.kind === "full" ? -1 : 1))
    for (const c of pending.slice(0, Math.max(0, MAX_VERIFY - verified.size))) {
      const v = await verifyCandidate(c, targets, opts)
      verified.set(c.slug, { ...c, ...v })
      trace("candidate", { slug: c.slug, title: c.title, match: v.kind || c.kind, score: +(v.score ?? c.score).toFixed(3), verdict: v.ok ? "verified" : "rejected", reason: v.reason })
    }
    const confirmed = [...verified.values()].filter((v) => v.ok && v.kind === "full")
    if (confirmed.length) {
      const pick = choose(confirmed, opts.year)
      log(`${pick.slug} confirmed at stage "${stage}" after ${sent} queries`)
      return { ...pick, evidence: "confirmed" }
    }
  }

  const sameName = (title) => targets.some((t) => similarity(fold(parseTitle(title).base), fold(parseTitle(t.title).base)) >= MATCH_THRESHOLD)
  for (const c of [...candidates.values()].filter((x) => !x.kind).slice(0, 15)) {
    const reason = c.rejected || (sameName(c.title) ? "same name, but its season/part/format marker does not match the request" : `title does not match (${c.score.toFixed(2)})`)
    trace("candidate", { slug: c.slug, title: c.title, score: +c.score.toFixed(3), verdict: "rejected", reason })
  }
  log(`targets=${JSON.stringify(targets.slice(0, 4).map((t) => t.title))} year=${opts.year} queries=${sent} candidates=${JSON.stringify([...candidates.values()].map((c) => [c.slug, +c.score.toFixed(2), c.kind]))}`)

  const probable = [...verified.values()].filter((v) => v.ok && v.kind === "partial")
  if (probable.length) {
    const pick = choose(probable, opts.year)
    log(`${pick.slug} accepted on a partial title match with the exact year ${opts.year}`)
    return { ...pick, evidence: "probable" }
  }
  if (candidates.size === 0 && errors.length && errors.length === sent) {
    throw errors.find((e) => e?.name === "BlockedError") || errors[0]
  }
  return null
}
exports.findEntry = findEntry

/** Compatibility helper: the queries of the first stages, flattened. */
exports.buildQueries = (titles) => buildSearchPlan({ primary: titles }).flatMap((s) => s.queries)

async function identityOrFail(seed, type, config) {
  const identity = await identityApi.identify(seed, type, { wantTvdb: String(config.numbering || "").startsWith("tvdb") })
  if (!identity) {
    const which = identityApi.identityProviders().join(", ") || "none"
    throw new ResolveError(`no metadata provider recognises ${JSON.stringify(seed)} (enabled: ${which})`, "IDENTITY_FAILED")
  }
  log(`identity ${JSON.stringify(seed)}: ${identity.name} (${identity.year}) via ${identity.sources.join("+")} | ${identity.evidence.join(" | ")}`)
  trace("identity", { name: identity.name, year: identity.year, names: identity.names, aliases: identity.aliases.slice(0, 8), sources: identity.sources, evidence: identity.evidence })
  return identity
}

/** A finished JKAnime entry with a known episode count cannot have more. */
function checkEpisodeExists(entry, episode, label) {
  const { episodes, status } = entry.info || {}
  if (episodes && status === "finished" && episode > episodes) {
    throw new ResolveError(`${label}: ${entry.slug} is finished with ${episodes} episodes`, "EPISODE_NOT_FOUND")
  }
}

async function resolveSeries(seed, season, episode, config) {
  if (season === 0) throw new ResolveError("season 0 (specials/OVAs) is not mapped to JKAnime episodes", "UNSUPPORTED_ID")
  const identity = await identityOrFail(seed, "series", config)
  let picked
  try {
    picked = await identityApi.layoutFor(identity, config.numbering || "auto")
  } catch (err) {
    throw new ResolveError(err.message, "NUMBERING_UNAVAILABLE")
  }
  const { layout } = picked
  const mapping = config.mapping || "auto"
  const seasonYear = layout[season]?.startYear ?? (season === 1 ? identity.year : null)
  const label = `${identity.name} T${season} E${episode}`
  const canonical = (s) => identity.names.map((n) => ({ title: n, season: s, canonical: true }))
  // Provider aliases are weaker than names: matched with markers, still year-verified.
  const aliases = (s) => identity.aliases.map((a) => ({ title: a, season: parseTitle(a).season ?? s }))
  const anilistFor = async (year, s) => entriesForSeason(await aniListEntriesFor(identity.searchNames, {
    year, formats: SERIES_FORMATS, known: identity.anilist.filter((m) => m.startYear === year),
  }), s).flatMap((m) => m.titles)
  trace("layout", { numbering: picked.numbering, season, episode, seasonYear, seasons: Object.keys(layout).length })

  // 1) An entry for this very season (JKAnime usually lists each season apart).
  // For later seasons the air year is the only safe way to tell entries apart,
  // so without it (season unknown to this numbering) this step is skipped.
  if (mapping !== "absolute" && (season === 1 || seasonYear)) {
    const seasonTitles = await anilistFor(seasonYear, season)
    const targets = [...canonical(season), ...seasonTitles.map((t) => ({ title: t, season: parseTitle(t).season ?? season })), ...aliases(season)]
    // For later seasons the air year is what tells "Black Clover 2nd Season" (2026)
    // apart from TMDB's season 2 (2018, part of the 170-episode entry).
    const entry = await findEntry(targets, { expectKind: "series", year: seasonYear })
    if (entry) {
      checkEpisodeExists(entry, episode, label)
      return { slug: entry.slug, episode, title: entry.title, label, via: `season/${picked.numbering}`, evidence: entry.evidence }
    }
  }

  // 2) JKAnime may list several seasons as one continuous entry.
  if (mapping !== "season" && (season > 1 || mapping === "absolute")) {
    const absolute = toAbsolute(layout, season, episode)
    if (!absolute) throw new ResolveError(`no ${picked.numbering} layout to compute absolute episode for ${label}`, "NUMBERING_UNAVAILABLE")
    const firstYear = layout[1]?.startYear ?? identity.year
    const baseTitles = await anilistFor(firstYear, 1)
    const baseTargets = [...canonical(1), ...baseTitles.map((t) => ({ title: t, season: parseTitle(t).season ?? 1 })), ...aliases(1)]
    const base = await findEntry(baseTargets, { expectKind: "series", year: firstYear })
    if (base) {
      if (base.info.episodes && absolute > base.info.episodes) {
        throw new ResolveError(`${label} = absolute episode ${absolute}, but ${base.slug} only has ${base.info.episodes} episodes`, "EPISODE_NOT_FOUND")
      }
      return { slug: base.slug, episode: absolute, title: base.title, label, via: `absolute/${picked.numbering}`, evidence: base.evidence }
    }
  }
  throw new ResolveError(`no JKAnime entry for ${label}`)
}

async function resolveMovie(seed, config) {
  const identity = await identityOrFail(seed, "movie", config)
  const entries = await aniListEntriesFor(identity.searchNames, { year: identity.year, formats: new Set(["MOVIE"]) })
  const targets = [...identity.names.map((n) => ({ title: n, canonical: true })), ...entries.flatMap((m) => m.titles).map((t) => ({ title: t })), ...identity.aliases.map((a) => ({ title: a }))]
  const entry = await findEntry(targets, { expectKind: "movie", year: identity.year })
  if (!entry) throw new ResolveError(`no JKAnime movie for ${identity.name} (${identity.year})`)
  return { slug: entry.slug, episode: 1, title: entry.title, label: identity.name, via: "movie", evidence: entry.evidence }
}

const formatGroup = (format) => (format === "MOVIE" ? "movie" : SERIES_FORMATS.has(format) ? "series" : OVA_FORMATS.has(format) ? "ova" : format || null)

/** Do two sets of titles name the same show (same base name)? */
const titlesAgree = (a, b) => a.some((x) => b.some((y) => similarity(fold(parseTitle(x).base), fold(parseTitle(y).base)) >= MATCH_THRESHOLD))

/**
 * Evidence level of a link between the requested entry and another database
 * entry. Missing data is never taken as agreement:
 * - confirmed:     same format, both start years known and within a year
 * - probable:      a start year is missing, but the titles agree and at
 *                  least two independent sources declare the link
 * - contradictory: different format, start years too far apart, or season
 *                  markers that name different seasons
 * - insufficient:  anything else
 */
function linkEvidence(entry, other, sources) {
  if (formatGroup(other.format) !== formatGroup(entry.format)) return { level: "contradictory", why: `format ${other.format}/${entry.format}` }
  const a = seasonMarkerOf(entry.titles) ?? 1
  const b = seasonMarkerOf(other.titles) ?? 1
  if (a !== b) return { level: "contradictory", why: `season ${b}/${a}` }
  if (entry.startYear && other.startYear) {
    return Math.abs(other.startYear - entry.startYear) <= 1
      ? { level: "confirmed", why: `format+year ${other.startYear}` }
      : { level: "contradictory", why: `year ${other.startYear}/${entry.startYear}` }
  }
  if (titlesAgree(entry.titles, other.titles) && sources.size >= 2) return { level: "probable", why: `year unknown; titles agree; ${sources.size} sources` }
  return { level: "insufficient", why: `year unknown and ${titlesAgree(entry.titles, other.titles) ? "a single source" : "titles differ"}` }
}
exports.linkEvidence = linkEvidence

/**
 * Titles for a kitsu:/mal:/anilist: entry, completed with the titles of the
 * SAME entry in other databases. Kitsu often has a single romaji title
 * ("Aoashi 2nd Season") while AniList and ani.zip add others ("Aoashi
 * Season 2", "Ao Ashi S2"). A linked AniList entry is used only when the
 * link is confirmed or probable (see linkEvidence), so a link can never
 * pull in another season's titles.
 * @returns {Promise<{entry, titles: string[], alternatives: string[], evidence: string[]}>}
 */
async function animeDbTitles(source, id) {
  const entry = source === "kitsu" ? await kitsu.getById(id) : await anilist.getById(source, id)
  const alternatives = []
  const evidence = []
  const claims = new Map() // anilist id -> sources
  const claim = (aid, why) => { if (aid) (claims.get(String(aid)) || claims.set(String(aid), new Set()).get(String(aid))).add(why) }
  const settle = (p) => p.catch((err) => { log(`cross-identification ${source}:${id}: ${err.message}`); return null })

  const [mappings, rels] = await Promise.all([
    source === "kitsu" ? settle(kitsu.getMappings(id)) : Promise.resolve(null),
    settle(relations.lookup(source, id)),
  ])
  if (mappings?.anilist) claim(mappings.anilist, "kitsu-mappings")
  const anizipTitles = []
  for (const { db, ids } of rels || []) {
    if (ids.anilist) claim(ids.anilist, db)
    if (db === "anizip" && ids.titles) anizipTitles.push({ anilist: ids.anilist, titles: ids.titles })
  }

  // mal: ids are read from AniList: that record is the requested entry itself.
  const accepted = new Set(entry.source === "anilist" && entry.id ? [String(entry.id)] : [])
  for (const [aid, why] of claims) {
    if (accepted.has(aid)) continue
    const other = await settle(anilist.getById("anilist", aid))
    if (!other) continue
    const link = linkEvidence(entry, other, why)
    trace("link", { from: `${source}:${id}`, to: `anilist:${aid}`, via: [...why], level: link.level, why: link.why })
    if (link.level !== "confirmed" && link.level !== "probable") {
      log(`ignoring anilist:${aid} for ${source}:${id}: ${link.level} (${link.why})`)
      continue
    }
    accepted.add(aid)
    alternatives.push(...other.titles)
    evidence.push(`anilist:${aid} ${link.level} via ${[...why].join("+")}`)
  }
  // The relation databases are also indexed by AniList id, which they cover
  // better than MAL or Kitsu ids: ask again for each accepted AniList entry.
  const lookedUp = new Set(source === "anilist" ? [String(id)] : [])
  for (const aid of accepted) {
    if (lookedUp.has(aid)) continue
    lookedUp.add(aid)
    for (const { db, ids } of (await settle(relations.lookup("anilist", aid))) || []) {
      if (db === "anizip" && ids.titles) anizipTitles.push({ anilist: ids.anilist || aid, titles: ids.titles })
    }
  }
  // ani.zip titles describe the record it was asked about: keep them only when
  // that record is an accepted AniList entry, or carries no AniList id (then
  // it is the requested id itself).
  for (const z of anizipTitles) {
    if (z.anilist && !accepted.has(String(z.anilist))) continue
    alternatives.push(...z.titles.filter(isLatinTitle))
    if (!evidence.includes("ani.zip titles")) evidence.push("ani.zip titles")
  }
  const titles = [...new Set(entry.titles)]
  const all = [...(entry.aliases || []), ...alternatives]
  return { entry, titles, alternatives: [...new Set(all)].filter((t) => !titles.includes(t)), evidence }
}

async function resolveAnimeDb(source, id, episode) {
  const { entry, titles, alternatives, evidence } = await animeDbTitles(source, id)
  if (!titles.length && !alternatives.length) throw new ResolveError(`${source}:${id} has no usable titles`)
  const name = titles[0] || alternatives[0]
  const ep = episode ?? 1
  const label = `${name} E${ep}`
  log(`${source}:${id}: ${titles.length}+${alternatives.length} titles (${evidence.join(", ") || "single source"})`)
  trace("identity", { name, year: entry.startYear, format: entry.format, episodes: entry.episodes, names: titles, aliases: alternatives, sources: [source], evidence })
  if (entry.episodes && ep > entry.episodes) {
    throw new ResolveError(`${source}:${id} has ${entry.episodes} episodes; episode ${ep} does not exist`, "EPISODE_NOT_FOUND")
  }
  const expectKind = entry.format === "MOVIE" ? "movie" : OVA_FORMATS.has(entry.format) ? "ova" : "series"
  const targets = [...titles.map((t) => ({ title: t, primary: true })), ...alternatives.map((t) => ({ title: t }))]
  const found = await findEntry(targets, { expectKind, year: entry.startYear, maxEpisodes: entry.episodes })
  if (!found) throw new ResolveError(`no JKAnime entry for ${source}:${id} (${name})`)
  checkEpisodeExists(found, ep, label)
  return { slug: found.slug, episode: ep, title: found.title, label, via: source, evidence: found.evidence }
}

/**
 * @param {string} type - Stremio type (series, movie, anime)
 * @param {string} rawId - Stremio video id
 * @param {{numbering?: string, mapping?: "auto"|"season"|"absolute"}} config
 *        numbering: auto (Cinemeta, else TMDB, else TVDB), cinemeta, tmdb, tvdb, tvdb-<order>
 * @returns {Promise<{slug, episode, title, label, via, evidence}>}
 */
exports.resolve = async function resolve(type, rawId, config = {}) {
  const id = parseVideoId(rawId)
  if (!id) throw new ResolveError(`unsupported id: ${rawId}`, "UNSUPPORTED_ID")

  if (id.source === "imdb" || id.source === "tmdb" || id.source === "tvdb") {
    const seed = { [id.source]: id.id }
    let cfg = config
    // tmdb:/tvdb: ids come from TMDB/TVDB catalogs, so they use that numbering unless told otherwise.
    if (id.source !== "imdb" && (!config.numbering || config.numbering === "auto")) cfg = { ...config, numbering: id.source }
    if (id.season !== undefined) return resolveSeries(seed, id.season, id.episode, cfg)
    if (type === "series") throw new ResolveError("series request without season/episode", "UNSUPPORTED_ID")
    if (id.source === "tvdb") throw new ResolveError("tvdb movie ids are not supported", "UNSUPPORTED_ID")
    return resolveMovie(seed, cfg)
  }
  return resolveAnimeDb(id.source, id.id, id.episode)
}
