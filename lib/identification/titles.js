/**
 * Title normalisation and conservative matching between metadata titles
 * (Cinemeta / AniList / Kitsu) and JKAnime listing titles.
 */

const ROMAN = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8 }
const ORDINAL_ES = "(?:ra|da|era|ta|na|ma|va|a|ª|°|º)"

function normalize(title) {
  return String(title || "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}ªº°]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Folds romanisation variants of the same Japanese sounds, applied to a
 * normalized string: "jyouheki"/"jouheki"/"joheki", "ojousama"/"ojosama",
 * "kouhai"/"kohai", "yuuki"/"yuki", particle "wo"/"o".
 */
function fold(normalized) {
  return String(normalized || "")
    .replace(/\bwo\b/g, "o")
    .replace(/jy(?=[aou])/g, "j")
    .replace(/ou|oo/g, "o")
    .replace(/uu/g, "u")
}

const YEAR_TAG = /\(\s*((?:19|20)\d{2})\s*\)/

/** True when a string is mostly Latin script (JKAnime only indexes those titles). */
function isLatinTitle(title) {
  const letters = String(title || "").match(/\p{L}/gu) || []
  if (letters.length === 0) return false
  const latin = letters.filter((ch) => /\p{Script=Latin}/u.test(ch)).length
  return latin / letters.length >= 0.8
}

const SEASON_PATTERNS = [
  new RegExp(`\\b(?:season|temporada|saison|staffel)\\s*(\\d{1,2})\\b`),
  new RegExp(`\\b(\\d{1,2})\\s*(?:st|nd|rd|th)\\s+season\\b`),
  new RegExp(`\\b(\\d{1,2})\\s*${ORDINAL_ES}\\s+temporada\\b`),
  /\bs(\d{1,2})\b/,
  /\bdai\s*(\d{1,2})\s*ki\b/,
]
const PART_PATTERN = /\b(?:part|parte|cour)\s*(\d{1,2})\b|\b(\d{1,2})\s*(?:st|nd|rd|th)\s+(?:part|cour)\b/
const KIND_PATTERNS = [
  ["movie", /\b(?:movie|pelicula|gekijouban|the movie|film)\b/],
  ["ova", /\b(?:ova|oad|ovas)\b/],
  ["special", /\b(?:special|specials|especial|especiales|recap|jump festa|picture drama)\b/],
]

/**
 * Splits a title into its base name and season/part/kind markers.
 * "Black Clover 2nd Season" -> { base: "black clover", season: 2 }
 * "Black Clover (TV)"       -> { base: "black clover", season: null }
 */
function parseTitle(title) {
  // "Fruits Basket (2019)": the year tells a remake apart; it is not part of the name.
  const yearTag = String(title || "").match(YEAR_TAG)
  const raw = yearTag ? String(title).replace(YEAR_TAG, " ") : title
  let s = normalize(raw)
  let season = null
  let part = null
  let kind = null
  let finalSeason = false

  for (const [k, re] of KIND_PATTERNS) {
    if (re.test(s)) { kind = k; break }
  }
  const partMatch = s.match(PART_PATTERN)
  if (partMatch) {
    part = Number(partMatch[1] || partMatch[2])
    s = s.replace(PART_PATTERN, " ")
  }
  if (/\bfinal season\b|\btemporada final\b/.test(s)) {
    finalSeason = true
    s = s.replace(/\bfinal season\b|\btemporada final\b/, " ")
  }
  for (const re of SEASON_PATTERNS) {
    const m = s.match(re)
    if (m) {
      season = Number(m[1])
      s = s.replace(re, " ")
      break
    }
  }
  s = s.replace(/\s+/g, " ").trim()
  if (season === null) {
    const roman = s.match(/\s(ii|iii|iv|v|vi|vii|viii)$/)
    const digit = s.match(/\s([2-9])$/)
    if (roman) { season = ROMAN[roman[1]]; s = s.slice(0, -roman[0].length) }
    else if (digit) { season = Number(digit[1]); s = s.slice(0, -digit[0].length) }
  }
  // "(TV)" and "TV" only disambiguate from movies on JKAnime, they are not part of the name.
  s = s.replace(/\b(?:tv|the animation|anime)\b/g, " ").replace(/\s+/g, " ").trim()
  return { base: s, season, part, kind, finalSeason, year: yearTag ? Number(yearTag[1]) : null, normalized: normalize(raw) }
}

function bigrams(s) {
  const compact = s.replace(/\s+/g, " ")
  const out = new Map()
  for (let i = 0; i < compact.length - 1; i++) {
    const g = compact.slice(i, i + 2)
    out.set(g, (out.get(g) || 0) + 1)
  }
  return out
}

/**
 * Sørensen–Dice coefficient over character bigrams, 0..1.
 * Titles that differ only in word spacing ("Aoashi" / "Ao Ashi",
 * "Dragonball" / "Dragon Ball") count as identical; anything else is scored
 * normally, so this does not loosen the match threshold.
 */
function similarity(a, b) {
  if (a === b) return 1
  const compactA = a.replace(/\s+/g, "")
  if (compactA.length >= 4 && compactA === b.replace(/\s+/g, "")) return 1
  // Same words in another romanisation ("Koori no Jyouheki" / "Koori no Jouheki").
  const foldedA = fold(a).replace(/\s+/g, "")
  if (foldedA.length >= 4 && foldedA === fold(b).replace(/\s+/g, "")) return 1
  if (a.length < 2 || b.length < 2) return 0
  const A = bigrams(a)
  const B = bigrams(b)
  let inter = 0
  let total = 0
  for (const [g, n] of A) { inter += Math.min(n, B.get(g) || 0); total += n }
  for (const n of B.values()) total += n
  return (2 * inter) / total
}

const NON_SERIES_KINDS = new Set(["movie", "ova", "special"])

/**
 * When the JKAnime title is the target title plus a suffix ("Black Clover" +
 * "(TV)" / "2nd Season" / ": Mahou Tei no Ken"), reads the suffix alone.
 * This keeps numbers that belong to the name ("Kaiju No. 8") out of the
 * season logic.
 * @returns {null|{season: number|null, part: number|null, kind: string|null, extra: string}}
 */
function suffixOf(candidateNorm, targetNorm) {
  // Romanisation is folded only to compare the shared prefix; the suffix is
  // read unfolded, or folding would hide markers ("cour" -> "cor").
  const foldedC = fold(candidateNorm)
  const foldedT = fold(targetNorm)
  if (foldedC !== foldedT && !foldedC.startsWith(foldedT + " ")) return null
  // fold() keeps word boundaries, so the target's word count marks the suffix.
  const rest = parseTitle("x " + candidateNorm.split(" ").slice(targetNorm.split(" ").length).join(" "))
  return { season: rest.season, part: rest.part, kind: rest.kind, extra: rest.base.replace(/^x\b\s*/, "") }
}

/**
 * Scores how well a JKAnime title matches one target title.
 * @param {string} candidateTitle - title from JKAnime
 * @param {{title: string, season?: number|null, canonical?: boolean}} target
 *        season: season implied by the request. canonical: the title is the show's
 *        name from Cinemeta, so any number in it is part of the name and the
 *        requested season comes only from `season`.
 * @param {"series"|"movie"|"ova"} expectKind
 * @returns {number} 0..1, 0 when season/part/kind are incompatible
 */
function scoreTitle(candidateTitle, target, expectKind = "series") {
  const c = parseTitle(candidateTitle)
  const t = parseTitle(target.title)
  if (!c.base || !t.base) return 0
  // "ova": the requested entry is an OVA/special itself; only movies are out.
  const blockedKind = (kind) => expectKind === "series"
    ? kind && NON_SERIES_KINDS.has(kind) && kind !== t.kind
    : expectKind === "ova" ? kind === "movie" : kind === "ova" || kind === "special"

  const suffix = suffixOf(c.normalized, t.normalized)
  if (suffix) {
    if (blockedKind(suffix.kind)) return 0
    if (suffix.part && suffix.part > 1) return 0
    if (target.canonical) {
      const wanted = expectKind !== "movie" ? (target.season ?? 1) : 1
      if ((suffix.season ?? 1) !== wanted) return 0
    } else if (suffix.season && suffix.season !== 1) {
      // The target names one specific entry; a season marker on top is another entry.
      return 0
    }
    return suffix.extra ? similarity(fold(c.normalized), fold(t.normalized)) : 1
  }

  if (blockedKind(c.kind)) return 0
  const wanted = expectKind !== "movie"
    ? (target.canonical ? target.season ?? 1 : t.season ?? target.season ?? 1)
    : (target.canonical ? 1 : t.season ?? 1)
  if ((c.season ?? 1) !== wanted) return 0
  if (expectKind !== "movie") {
    if (t.part && (c.part || 1) !== t.part) return 0
    if (!t.part && c.part && c.part > 1) return 0
    if (c.finalSeason !== t.finalSeason) return 0
  }
  return similarity(c.base, t.base)
}

/** Words that say nothing about which show a fragment names. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "your", "you", "are", "was", "who", "how", "what", "when", "can", "not", "but", "its", "his", "her", "they", "their", "will", "about", "after", "most", "girl", "boy", "school", "world", "season", "part", "movie", "anime", "secretly", "isekai",
  "los", "las", "una", "uno", "del", "con", "por", "para", "que", "como", "sus", "mas",
  "wa", "ga", "no", "ni", "wo", "de", "to", "mo", "ka", "na", "yo", "ne", "e", "o", "shita", "suru", "naru", "narimashita", "desu", "masu", "kun", "chan", "san", "sama",
])

/** Words of a fragment that identify a show (not particles, not filler). */
const contentWords = (normalized) => normalized.split(" ").filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w))

/**
 * Parts of a long title as written: "Saijo no Osewa: Takane no Hanadarake na
 * Meimonkou de, ..." -> ["saijo no osewa", "takane no hanadarake na meimonkou de", ...].
 * Splits on ":", " - ", "~", "(", ")", "!", "?", "," and similar punctuation.
 */
function segments(title) {
  const raw = String(title || "").replace(YEAR_TAG, " ")
  return raw.split(/\s*(?:[:：~〜()（）!！?？,，;、」「『』]|\s[-–—]\s)\s*/)
    .map((p) => normalize(p)).filter(Boolean)
}

/**
 * The main name of a title with a subtitle: the first segment when the
 * title has more than one and that segment is distinctive on its own.
 * "Rich Girl Caretaker: I'm Secretly..." -> "rich girl caretaker"
 */
function mainName(title) {
  const parts = segments(title)
  if (parts.length < 2) return null
  const first = parts[0]
  return first.split(" ").length >= 2 && contentWords(first).length >= 1 && first.length >= 8 ? first : null
}

module.exports = { normalize, fold, parseTitle, similarity, scoreTitle, isLatinTitle, segments, mainName, contentWords }
