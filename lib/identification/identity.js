/**
 * Identifies a series/movie from an IMDb, TMDB or TVDB id using several
 * metadata providers, and records which id correspondences are verified.
 *
 * Rules:
 * - A provider's own id index (TMDB /find, TVDB remote ids, Cinemeta keyed by
 *   IMDb) is a direct relation. If a provider reports a different IMDb id than
 *   the one requested, its answer is discarded.
 * - Providers that contradict each other (different ids for the same thing,
 *   or unrelated names AND years) are dropped in priority order TMDB > TVDB > Cinemeta.
 * - Relation databases (yuna, ani.zip) only propose AniList/MAL/Kitsu links;
 *   a link is accepted when a second, independent source confirms it.
 * - Several distinct TMDB/TVDB results for one IMDb id = ambiguous = unused.
 */
const cinemeta = require("../providers/cinemeta")
const tmdb = require("../providers/tmdb")
const tvdb = require("../providers/tvdb")
const anilist = require("../providers/anilist")
const relations = require("../providers/relations")
const { cache, env, log } = require("../providers/common")
const { isLatinTitle, parseTitle, similarity, normalize } = require("./titles")

const PRIORITY = ["tmdb", "tvdb", "cinemeta"]
const NAME_MATCH = 0.88
const SERIES_FORMATS = new Set(["TV", "TV_SHORT", "ONA"])
const MOVIE_FORMATS = new Set(["MOVIE"])

/** Which providers may identify ids (METADATA_PROVIDER=auto|tmdb|tvdb|cinemeta). */
function identityProviders() {
  const choice = (env("METADATA_PROVIDER") || "auto").toLowerCase()
  const all = { tmdb, tvdb, cinemeta }
  const order = choice in all ? [choice] : PRIORITY
  return order.filter((p) => all[p].enabled())
}
exports.identityProviders = identityProviders

/** Awaits a provider call; a failure is logged, recorded in `errors` and becomes null. */
const settle = async (label, promise, errors) => {
  try {
    return await promise
  } catch (err) {
    if (errors) errors.push(label)
    log(`${label}: ${err.status === 401 ? "authentication failed (check credentials)" : err.message}`)
    return null
  }
}

const bases = (identity) => [identity.name, identity.originalName, ...(identity.aliases || [])]
  .filter((n) => n && isLatinTitle(n)).map((n) => parseTitle(n).base).filter(Boolean)

function namesAgree(a, b) {
  const A = bases(a)
  const B = bases(b)
  return A.some((x) => B.some((y) => x === y || similarity(x, y) >= NAME_MATCH))
}

/** Two identities for the same request contradict each other. */
function conflicts(a, b) {
  for (const key of ["imdb", "tmdb", "tvdb"]) {
    if (a.ids[key] && b.ids[key] && a.ids[key] !== b.ids[key]) return `${key} ${a.ids[key]} vs ${b.ids[key]}`
  }
  const yearsClose = !a.year || !b.year || Math.abs(a.year - b.year) <= 1
  if (!yearsClose && !namesAgree(a, b)) return `names and years differ (${a.year} vs ${b.year})`
  return null
}

async function tmdbFromImdb(imdbId, type) {
  const found = await tmdb.findByImdb(imdbId)
  const ids = type === "movie" ? found.movie : found.tv
  if (ids.length !== 1) {
    if (ids.length > 1) log(`TMDB has ${ids.length} ${type} results for ${imdbId}; ambiguous, ignored`)
    return null
  }
  const info = type === "movie" ? await tmdb.getMovie(ids[0]) : await tmdb.getTv(ids[0])
  if (info.ids.imdb && info.ids.imdb !== imdbId) return null
  return { ...info, ids: { ...info.ids, imdb: imdbId }, evidence: [`tmdb:/find(${imdbId}) -> tv/${ids[0]}`] }
}

async function tvdbFromImdb(imdbId, type) {
  if (type === "movie") return null
  const found = await tvdb.findByImdb(imdbId)
  if (found.series.length !== 1) {
    if (found.series.length > 1) log(`TVDB has ${found.series.length} series for ${imdbId}; ambiguous, ignored`)
    return null
  }
  const info = await tvdb.getSeries(found.series[0])
  if (info.ids.imdb && info.ids.imdb !== imdbId) return null
  return { ...info, ids: { ...info.ids, imdb: imdbId }, evidence: [`tvdb:remoteid(${imdbId}) -> series/${found.series[0]}`] }
}

async function cinemetaFromImdb(imdbId, type) {
  const info = await cinemeta.getByImdb(type, imdbId)
  return info ? { ...info, evidence: [`cinemeta:${type}/${imdbId}`] } : null
}

/**
 * Collects identities for a seed id. TVDB is only asked when TMDB has no
 * reliable answer, or when its data is explicitly needed (numbering=tvdb…).
 */
async function collect(seed, type, { wantTvdb = false } = {}, errors = []) {
  const providers = identityProviders()
  const found = {}
  if (seed.imdb) {
    const jobs = []
    if (providers.includes("tmdb")) jobs.push(["tmdb", settle(`TMDB ${seed.imdb}`, tmdbFromImdb(seed.imdb, type), errors)])
    if (providers.includes("cinemeta")) {
      // Cinemeta answering {} ("unknown id") is not the same as Cinemeta failing.
      jobs.push(["cinemeta", cinemetaFromImdb(seed.imdb, type).catch((err) => {
        log(`Cinemeta ${seed.imdb}: ${err.message}`)
        found.cinemetaUnavailable = true
        return null
      })])
    }
    for (const [name, p] of jobs) found[name] = await p
    if (providers.includes("tvdb") && (!found.tmdb || wantTvdb)) {
      found.tvdb = await settle(`TVDB ${seed.imdb}`, tvdbFromImdb(seed.imdb, type), errors)
    }
  } else if (seed.tmdb && tmdb.enabled()) {
    const info = await settle(`TMDB ${seed.tmdb}`, type === "movie" ? tmdb.getMovie(seed.tmdb) : tmdb.getTv(seed.tmdb), errors)
    if (info) found.tmdb = { ...info, evidence: [`tmdb:${type}/${seed.tmdb}`] }
  } else if (seed.tvdb && tvdb.enabled()) {
    const info = await settle(`TVDB ${seed.tvdb}`, tvdb.getSeries(seed.tvdb), errors)
    if (info) found.tvdb = { ...info, evidence: [`tvdb:series/${seed.tvdb}`] }
  }
  // A TMDB/TVDB seed may also be known to Cinemeta through its IMDb id.
  const imdb = seed.imdb || found.tmdb?.ids.imdb || found.tvdb?.ids.imdb
  if (!seed.imdb && imdb && providers.includes("cinemeta")) found.cinemeta = await settle(`Cinemeta ${imdb}`, cinemetaFromImdb(imdb, type), errors)
  return found
}

/** Keeps mutually consistent identities, preferring TMDB > TVDB > Cinemeta. */
function reconcile(found) {
  const kept = []
  const dropped = []
  for (const name of PRIORITY) {
    const id = found[name]
    if (!id) continue
    const clash = kept.map((k) => conflicts(k, id)).find(Boolean)
    if (clash) dropped.push(`${name} (${clash})`)
    else kept.push(id)
  }
  if (dropped.length) log(`inconsistent providers ignored: ${dropped.join("; ")}`)
  return kept
}

/**
 * Accepts AniList links proposed by relation databases only when the AniList
 * entry has a compatible format, its titles match the verified identity, and
 * either its year matches or a second database confirms the link.
 */
async function verifiedAniList(identity, errors = []) {
  const claims = new Map() // anilistId -> Set(evidence)
  const add = (id, why) => { if (id) (claims.get(id) || claims.set(id, new Set()).get(id)).add(why) }
  const lookups = []
  if (identity.ids.tmdb && identity.type === "series") lookups.push(["tmdb", identity.ids.tmdb])
  if (identity.ids.tvdb) lookups.push(["tvdb", identity.ids.tvdb])
  for (const [source, id] of lookups) {
    for (const { db, ids } of await settle(`relations ${source}:${id}`, relations.lookup(source, id), errors) || []) {
      add(ids.anilist, `${db}:${source}/${id}`)
    }
  }
  const accepted = []
  for (const [anilistId, why] of claims) {
    // Reverse check: what do the databases say about this AniList entry?
    for (const { db, ids } of await settle(`relations anilist:${anilistId}`, relations.lookup("anilist", anilistId), errors) || []) {
      if (ids.imdb && ids.imdb === identity.ids.imdb) why.add(`${db}:anilist/${anilistId}->imdb`)
      if (ids.tvdb && ids.tvdb === identity.ids.tvdb) why.add(`${db}:anilist/${anilistId}->tvdb`)
      if (ids.tmdb && ids.tmdb === identity.ids.tmdb && identity.type === "series") why.add(`${db}:anilist/${anilistId}->tmdb`)
    }
    const dbs = new Set([...why].map((w) => w.split(":")[0]))
    const entry = await settle(`AniList ${anilistId}`, anilist.getById("anilist", anilistId), errors)
    if (!entry) continue
    // Relation databases do get it wrong: both yuna and ani.zip map tt7441658
    // (Black Clover) to AniList 87528, the Jump Festa 2016 special. So a claim
    // also needs a compatible format and a matching title.
    const formatOk = (identity.type === "movie" ? MOVIE_FORMATS : SERIES_FORMATS).has(entry.format)
    const titleOk = namesAgree(identity, { name: null, aliases: entry.titles })
    const yearOk = Boolean(entry.startYear && identity.year && Math.abs(entry.startYear - identity.year) <= 1)
    if (formatOk && titleOk && (yearOk || dbs.size >= 2)) {
      accepted.push({ entry, evidence: [...why, "format", "title", ...(yearOk ? ["year"] : [])] })
    } else {
      log(`AniList ${anilistId} claimed by ${[...why].join(", ")} rejected (format=${formatOk} title=${titleOk} year=${yearOk})`)
    }
  }
  return accepted
}

/**
 * @param {{imdb?: string, tmdb?: string, tvdb?: string}} seed
 * @param {"series"|"movie"} type
 * @returns {Promise<Identity|null>} null when no provider recognises the id
 */
exports.identify = async (seed, type, opts = {}) => {
  const key = `identity:${type}:${JSON.stringify(seed)}:${opts.wantTvdb ? 1 : 0}:${env("METADATA_PROVIDER")}`
  const identity = await cache.wrap(key, () => build(seed, type, opts))
  // Built while a provider was failing: keep it only briefly.
  if (identity?.degraded) cache.set(key, Promise.resolve(identity), 60 * 1000)
  return identity?.none ? null : identity
}

async function build(seed, type, opts) {
  const errors = []
  const found = await collect(seed, type, opts, errors)
  const kept = reconcile(found)
  if (kept.length === 0) return errors.length || found.cinemetaUnavailable ? { degraded: true, names: [], none: true } : null
  const primary = kept[0]
  const ids = {}
  for (const k of kept) for (const [key, v] of Object.entries(k.ids)) if (v && !ids[key]) ids[key] = v
  const names = []
  const pushName = (n) => { if (n && isLatinTitle(n) && !names.some((x) => normalize(x) === normalize(n))) names.push(n) }
  for (const k of kept) { pushName(k.name); pushName(k.originalName) }
  const aliases = [...new Set(kept.flatMap((k) => k.aliases || []).filter((a) => !names.includes(a)))]
  const identity = {
    type,
    name: names[0] || primary.name,
    names,
    aliases,
    // Native titles still help AniList search ("幻想水滸伝").
    searchNames: [...names, ...kept.map((k) => k.originalName).filter((n) => n && !isLatinTitle(n))],
    year: Math.min(...kept.map((k) => k.year).filter(Boolean)) || null,
    layouts: Object.fromEntries(kept.filter((k) => k.layout).map((k) => [k.provider, k.layout])),
    ids,
    sources: kept.map((k) => k.provider),
    evidence: kept.flatMap((k) => k.evidence || []),
    anilist: [],
    cinemetaUnavailable: Boolean(found.cinemetaUnavailable),
    degraded: Boolean(found.cinemetaUnavailable) || errors.length > 0,
  }
  if (identity.names.length === 0) return null
  const accepted = await verifiedAniList(identity, errors)
  identity.degraded = identity.degraded || errors.length > 0
  for (const { entry, evidence } of accepted) {
    identity.anilist.push(entry)
    identity.evidence.push(`anilist/${entry.id}: ${evidence.join(", ")}`)
  }
  return identity
}

/**
 * Season layout for a numbering scheme.
 * auto: Cinemeta when it knows the show (unchanged v0.1 behaviour), else TMDB, else TVDB.
 */
exports.layoutFor = async (identity, numbering = "auto") => {
  const tvdbLayout = (order) => identity.ids.tvdb ? tvdb.getLayout(identity.ids.tvdb, order) : null
  if (numbering === "auto") {
    // Never switch numbering silently because Cinemeta is temporarily down:
    // for Black Clover that would turn S2E1 (2026 season) into episode 52.
    if (identity.cinemetaUnavailable && !identity.layouts.cinemeta) {
      throw new Error("Cinemeta is unavailable, so the default numbering cannot be determined; try again later or set numbering explicitly")
    }
    if (identity.layouts.cinemeta && Object.keys(identity.layouts.cinemeta).length) return { layout: identity.layouts.cinemeta, numbering: "cinemeta" }
    if (identity.layouts.tmdb && Object.keys(identity.layouts.tmdb).length) return { layout: identity.layouts.tmdb, numbering: "tmdb" }
    if (identity.ids.tvdb && tvdb.enabled()) {
      const layout = await settle(`TVDB layout ${identity.ids.tvdb}`, tvdbLayout("default"))
      if (layout) return { layout, numbering: "tvdb" }
    }
    return { layout: {}, numbering: "none" }
  }
  if (numbering === "cinemeta" || numbering === "tmdb") {
    const layout = identity.layouts[numbering]
    if (!layout) throw new Error(`numbering=${numbering} requested but ${numbering} does not know this show`)
    return { layout, numbering }
  }
  if (numbering.startsWith("tvdb")) {
    if (!identity.ids.tvdb || !tvdb.enabled()) throw new Error(`numbering=${numbering} requires TVDB_API_KEY and a TVDB match`)
    return { layout: await tvdbLayout(numbering.split("-")[1] || "default"), numbering }
  }
  throw new Error(`unknown numbering ${numbering}`)
}
