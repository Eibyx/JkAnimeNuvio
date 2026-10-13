/**
 * JKAnime search plan: which queries to send, in which order. Every query is
 * derived by general rules from the titles of the requested show; nothing
 * here knows about a particular anime.
 *
 * Stages (searched in order; the resolver stops as soon as an entry is
 * verified):
 *   1. titles        the show's own names: base name (season marker removed)
 *                    and the full name when it is short enough to search
 *   2. alternatives  verified alternative titles (AniList, ani.zip, aliases)
 *   3. variants      other romanisations of stages 1-2 ("jyouheki" -> "jouheki")
 *   4. fragments     distinctive parts of long titles: main name before the
 *                    subtitle, first words of each long segment, and the
 *                    main name joined with the start of the next segment
 * A query found through a fragment only proposes candidates: they are still
 * scored against the full titles and verified on the JKAnime page.
 */
const { normalize, parseTitle, segments, mainName, contentWords } = require("./titles")

// JKAnime's search does not cope with whole sentences; longer titles are
// searched through their fragments instead.
const MAX_QUERY_WORDS = 8
const MIN_QUERY_LENGTH = 3
const FRAGMENT_WORDS = 3

const words = (q) => q.split(" ").filter(Boolean)

/** Spellings JKAnime may use for the same romaji. */
function variantsOf(q) {
  const out = []
  const jy = q.replace(/jy(?=[aou])/g, "j")
  if (jy !== q) out.push(jy)
  const long = jy.replace(/ou(?=[a-z]|\b)/g, "o").replace(/uu/g, "u")
  if (long !== jy) out.push(long)
  const particle = q.replace(/\bwo\b/g, "o")
  if (particle !== q) out.push(particle)
  return out
}

/**
 * Distinctive fragments of a long title, by kind: the main name, the main
 * name joined with the start of the subtitle, and the start of the subtitle.
 * Only the first two segments are used: later ones are rarely searchable.
 */
function fragmentsOf(title) {
  const parts = segments(title)
  const main = mainName(title)
  const prefix = (p) => words(p).slice(0, FRAGMENT_WORDS).join(" ")
  const distinctive = (f) => contentWords(f).length >= 2
  const out = { main: [], combined: [], prefixes: [] }
  if (main) out.main.push(main)
  const sub = main ? parts[1] : null
  if (sub && words(sub).length > FRAGMENT_WORDS && contentWords(prefix(sub)).length >= 1) {
    out.combined.push(`${main} ${prefix(sub)}`)
    if (distinctive(prefix(sub))) out.prefixes.push(prefix(sub))
  }
  // A long title without punctuation: its first words.
  if (parts.length === 1 && words(parts[0]).length > MAX_QUERY_WORDS && distinctive(prefix(parts[0]))) out.prefixes.push(prefix(parts[0]))
  return out
}

/**
 * @param {{primary: string[], alternatives?: string[]}} titles
 * @returns {Array<{stage: string, queries: string[]}>} non-empty stages, queries de-duplicated
 */
function buildSearchPlan({ primary = [], alternatives = [] }) {
  const seen = new Set()
  const stage = (name, list) => {
    const queries = []
    for (const raw of list) {
      const q = normalize(raw)
      if (q.length < MIN_QUERY_LENGTH || seen.has(q)) continue
      if (words(q).length > MAX_QUERY_WORDS) continue
      seen.add(q)
      queries.push(q)
    }
    return { stage: name, queries }
  }
  // Base names first: JKAnime words seasons its own way ("Ao Ashi Season 2").
  const namesOf = (titles) => [...titles.map((t) => parseTitle(t).base), ...titles.map((t) => parseTitle(t).normalized)]
  const s1 = stage("titles", namesOf(primary))
  const s2 = stage("alternatives", namesOf(alternatives))
  const s3 = stage("variants", [...s1.queries, ...s2.queries, ...namesOf([...primary, ...alternatives])].flatMap(variantsOf))
  const frags = [...primary, ...alternatives].map(fragmentsOf)
  const byKind = ["main", "combined", "prefixes"].flatMap((kind) => frags.flatMap((f) => f[kind]))
  const s4 = stage("fragments", byKind.flatMap((f) => [f, ...variantsOf(f)]))
  return [s1, s2, s3, s4].filter((s) => s.queries.length)
}

module.exports = { buildSearchPlan, fragmentsOf, variantsOf, MAX_QUERY_WORDS }
