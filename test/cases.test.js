/**
 * Identification case matrix.
 * REAL: Kitsu, AniList, yuna, ani.zip (test/fixtures/cases.json, aoashi.json)
 * and Cinemeta (cinemeta-koori.json, cinemeta-black-clover.json) answers.
 * JKAnime: "Ao Ashi", "Ao Ashi Season 2" and "Koori no Jouheki" are the real
 * titles (pages archived 2026); how JKAnime titles Rich Girl Caretaker and
 * the second season of Koori no Jouheki could not be checked, so every
 * plausible spelling is tested. Passing here does NOT confirm JKAnime.
 */
const { test, beforeEach, afterEach } = require("node:test")
const assert = require("node:assert/strict")
const { installFakeNet, resetAll, DEFAULT_ANIME } = require("../test-support/helpers")
const { resolve, linkEvidence } = require("../lib/identification/resolver")
const common = require("../lib/providers/common")

beforeEach(resetAll)
afterEach(() => { resetAll(); delete process.env.JK_MAX_QUERIES })

const KOORI_CINEMETA = { "series/tt39123061": require("./fixtures/cinemeta-koori.json") }
const KOORI = {
  "koori-no-jouheki": { title: "Koori no Jouheki", alt: "The Ramparts of Ice", type: "Serie", emitted: "Jueves, 02 de Abril de 2026", episodes: 14, status: "Concluido" },
  "koori-no-jouheki-2nd-season": { title: "Koori no Jouheki 2nd Season", type: "Serie", emitted: "Jueves, 01 de Octubre de 2026", episodes: 2, status: "En emision" },
}
const RICH = { type: "Serie", emitted: "Sábado, 04 de Julio de 2026", episodes: 12, status: "Concluido" }

const run = async (id, opts = {}) => {
  installFakeNet(opts)
  try {
    const r = await resolve(opts.type || "series", id, opts.config)
    return { slug: r.slug, episode: r.episode, evidence: r.evidence }
  } catch (err) {
    return { error: err.code || err.name, message: err.message }
  }
}
const slugEp = (r) => (r.error ? r.error : `${r.slug}#${r.episode}`)

test("Ao Ashi T1 kitsu:44629:1 -> ao-ashi, never the 2026 season", async () => {
  assert.equal(slugEp(await run("kitsu:44629:1")), "ao-ashi#1")
  assert.equal(slugEp(await run("kitsu:44629:24")), "ao-ashi#24")
  assert.equal((await run("kitsu:44629:25")).error, "EPISODE_NOT_FOUND", "Kitsu says 24 episodes")
})

test("Ao Ashi T2: kitsu:49883:1, :2 and anilist:191788:1 -> ao-ashi-season-2", async () => {
  for (const [id, want] of [["kitsu:49883:1", "ao-ashi-season-2#1"], ["kitsu:49883:2", "ao-ashi-season-2#2"], ["anilist:191788:1", "ao-ashi-season-2#1"]]) {
    resetAll()
    assert.equal(slugEp(await run(id)), want, id)
  }
})

test("Rich Girl Caretaker kitsu:50761:1 is found whichever title JKAnime uses", async () => {
  const spellings = {
    "saijo-no-osewa": "Saijo no Osewa",
    "rich-girl-caretaker": "Rich Girl Caretaker",
    "saijo-no-osewa-takane-no-hanadarake": "Saijo no Osewa: Takane no Hana-darake na Meimonkou de, Gakuin Ichi no Ojou-sama (Seikatsu Nouryoku Kaimu) o Kagenagara Osewa Suru Koto ni Narimashita",
  }
  for (const [slug, title] of Object.entries(spellings)) {
    resetAll()
    const r = await run("kitsu:50761:1", { anime: { ...DEFAULT_ANIME, [slug]: { ...RICH, title } } })
    assert.equal(slugEp(r), `${slug}#1`, title)
  }
})

test("Rich Girl Caretaker: a short JKAnime title needs the exact year and the right format", async () => {
  // Same main name, other year: a different show (or a remake), never served.
  let r = await run("kitsu:50761:1", { anime: { "saijo-no-osewa": { ...RICH, title: "Saijo no Osewa", emitted: "Abr 3 de 2025" } } })
  assert.equal(r.error, "ANIME_NOT_FOUND")
  resetAll()
  r = await run("kitsu:50761:1", { anime: { "saijo-no-osewa-movie": { ...RICH, title: "Saijo no Osewa", type: "Pelicula", episodes: 1 } } })
  assert.equal(r.error, "ANIME_NOT_FOUND")
  // A partial match is accepted only as "probable"; the full title is "confirmed".
  resetAll()
  r = await run("kitsu:50761:1", { anime: { "saijo-no-osewa": { ...RICH, title: "Saijo no Osewa" } } })
  assert.equal(r.evidence, "probable")
  resetAll()
  r = await run("kitsu:50761:1", { anime: { "saijo-no-osewa": { ...RICH, title: "Saijo no Osewa", alt: "Rich Girl Caretaker: I'm Secretly the Caregiver of the Most Popular Girl in This Rich Kid School" } } })
  assert.equal(r.evidence, "confirmed", "the JKAnime alternative title confirms it")
  resetAll()
  assert.equal((await run("kitsu:50761:13", { anime: { "saijo-no-osewa": { ...RICH, title: "Saijo no Osewa" } } })).error, "EPISODE_NOT_FOUND")
})

test("Koori no Jouheki T2 kitsu:50827:1 -> 2nd season, never season 1 (both aired in 2026)", async () => {
  assert.equal(slugEp(await run("kitsu:50827:1", { anime: KOORI })), "koori-no-jouheki-2nd-season#1")
  resetAll()
  const other = { "koori-no-jouheki": KOORI["koori-no-jouheki"], "koori-no-jouheki-season-2": { ...KOORI["koori-no-jouheki-2nd-season"], title: "Koori no Jouheki Season 2" } }
  assert.equal(slugEp(await run("kitsu:50827:1", { anime: other })), "koori-no-jouheki-season-2#1")
  resetAll()
  assert.equal((await run("kitsu:50827:1", { anime: { "koori-no-jouheki": KOORI["koori-no-jouheki"] } })).error, "ANIME_NOT_FOUND")
})

test("Koori no Jouheki by IMDb (Cinemeta writes 'Jyouheki'): T1 and T2", async () => {
  assert.equal(slugEp(await run("tt39123061:1:1", { anime: KOORI, cinemeta: KOORI_CINEMETA })), "koori-no-jouheki#1")
  resetAll()
  assert.equal(slugEp(await run("tt39123061:2:1", { anime: KOORI, cinemeta: KOORI_CINEMETA })), "koori-no-jouheki-2nd-season#1")
  // Without a season-2 entry: absolute 15 > 14 episodes, never S1E1.
  resetAll()
  assert.equal((await run("tt39123061:2:1", { anime: { "koori-no-jouheki": KOORI["koori-no-jouheki"] }, cinemeta: KOORI_CINEMETA })).error, "EPISODE_NOT_FOUND")
})

test("Black Clover tt7441658:2:1 and Gensou Suikoden tt42938834:1:1 / anilist:187316:1 keep working", async () => {
  assert.equal(slugEp(await run("tt7441658:2:1")), "black-clover-2nd-season#1")
  resetAll()
  assert.equal(slugEp(await run("anilist:187316:1")), "gensou-suikoden#1")
})

test("remakes: the year in the JKAnime title and on its page decides", async () => {
  const anime = {
    "fruits-basket": { title: "Fruits Basket", type: "Serie", emitted: "Jul 5 de 2001", episodes: 26, status: "Concluido" },
    "fruits-basket-2019": { title: "Fruits Basket (2019)", type: "Serie", emitted: "Abr 6 de 2019", episodes: 25, status: "Concluido" },
  }
  const entry = (year) => common.cache.set("kitsu:900", Promise.resolve({ source: "kitsu", id: "900", format: "TV", episodes: year === 2001 ? 26 : 25, startYear: year, titles: ["Fruits Basket"] }))
  installFakeNet({ anime })
  entry(2019)
  assert.equal((await resolve("series", "kitsu:900:1")).slug, "fruits-basket-2019")
  resetAll()
  installFakeNet({ anime })
  entry(2001)
  assert.equal((await resolve("series", "kitsu:900:1")).slug, "fruits-basket")
})

test("a JKAnime page without air year is not accepted when the year matters", async () => {
  const anime = { "fruits-basket": { title: "Fruits Basket", type: "Serie", emitted: "", episodes: 26, status: "Concluido" } }
  installFakeNet({ anime })
  common.cache.set("kitsu:900", Promise.resolve({ source: "kitsu", id: "900", format: "TV", episodes: 25, startYear: 2019, titles: ["Fruits Basket"] }))
  await assert.rejects(resolve("series", "kitsu:900:1"), { code: "ANIME_NOT_FOUND" })
})

test("formats: a movie entry only matches a JKAnime movie, an OVA only an OVA", async () => {
  const anime = {
    "kimetsu-no-yaiba": { title: "Kimetsu no Yaiba", type: "Serie", emitted: "Abr 6 de 2019", episodes: 26, status: "Concluido" },
    "kimetsu-no-yaiba-mugen-ressha-hen": { title: "Kimetsu no Yaiba: Mugen Ressha-hen", type: "Pelicula", emitted: "Oct 16 de 2020", episodes: 1, status: "Concluido" },
    "kimetsu-no-yaiba-mugen-ressha-hen-tv": { title: "Kimetsu no Yaiba: Mugen Ressha-hen (TV)", type: "Serie", emitted: "Oct 10 de 2021", episodes: 7, status: "Concluido" },
    "shingeki-no-kyojin-ova": { title: "Shingeki no Kyojin OVA", type: "OVA", emitted: "Dic 9 de 2013", episodes: 3, status: "Concluido" },
    "shingeki-no-kyojin": { title: "Shingeki no Kyojin", type: "Serie", emitted: "Abr 7 de 2013", episodes: 25, status: "Concluido" },
  }
  const set = (id, e) => common.cache.set(`kitsu:${id}`, Promise.resolve({ source: "kitsu", id: String(id), ...e }))
  installFakeNet({ anime })
  set(901, { format: "MOVIE", episodes: 1, startYear: 2020, titles: ["Kimetsu no Yaiba: Mugen Ressha-hen"] })
  assert.equal((await resolve("movie", "kitsu:901")).slug, "kimetsu-no-yaiba-mugen-ressha-hen")
  set(902, { format: "TV", episodes: 7, startYear: 2021, titles: ["Kimetsu no Yaiba: Mugen Ressha-hen"] })
  assert.equal((await resolve("series", "kitsu:902:1")).slug, "kimetsu-no-yaiba-mugen-ressha-hen-tv")
  set(903, { format: "OVA", episodes: 3, startYear: 2013, titles: ["Shingeki no Kyojin OVA"] })
  assert.equal((await resolve("series", "kitsu:903:1")).slug, "shingeki-no-kyojin-ova")
})

test("very similar titles of different shows never match", async () => {
  const anime = { "ore-no-imouto": { title: "Ore no Imouto", type: "Serie", emitted: "Oct 3 de 2010", episodes: 12, status: "Concluido" } }
  installFakeNet({ anime })
  common.cache.set("kitsu:904", Promise.resolve({ source: "kitsu", id: "904", format: "TV", episodes: 12, startYear: 2010, titles: ["Ore no Imouto ga Konna ni Kawaii Wake ga Nai"] }))
  await assert.rejects(resolve("series", "kitsu:904:1"), { code: "ANIME_NOT_FOUND" })
})

test("a JKAnime entry longer than the requested cut is not used for it", async () => {
  // Kitsu lists part 1 (12 episodes); JKAnime only has the 24-episode whole.
  const anime = { "spy-x-family": { title: "Spy x Family", type: "Serie", emitted: "Abr 9 de 2022", episodes: 25, status: "Concluido" } }
  installFakeNet({ anime })
  common.cache.set("kitsu:905", Promise.resolve({ source: "kitsu", id: "905", format: "TV", episodes: 12, startYear: 2022, titles: ["Spy x Family"] }))
  await assert.rejects(resolve("series", "kitsu:905:1"), { code: "ANIME_NOT_FOUND" })
})

test("link evidence: missing data is never agreement", () => {
  const k = { format: "TV", startYear: 2026, titles: ["Koori no Jouheki 2nd Season"] }
  const one = new Set(["kitsu-mappings"])
  const two = new Set(["kitsu-mappings", "yuna"])
  assert.equal(linkEvidence(k, { format: "TV", startYear: 2026, titles: ["Koori no Jouheki 2nd Season"] }, one).level, "confirmed")
  assert.equal(linkEvidence(k, { format: "TV", startYear: 2026, titles: ["Koori no Jouheki"] }, two).level, "contradictory", "same year, other season")
  assert.equal(linkEvidence(k, { format: "MOVIE", startYear: 2026, titles: ["Koori no Jouheki 2nd Season"] }, two).level, "contradictory")
  assert.equal(linkEvidence(k, { format: "TV", startYear: 2020, titles: ["Koori no Jouheki 2nd Season"] }, two).level, "contradictory")
  const noYear = { format: "TV", startYear: null, titles: ["Koori no Jouheki 2nd Season"] }
  assert.equal(linkEvidence(k, noYear, one).level, "insufficient", "year unknown, single source")
  assert.equal(linkEvidence(k, noYear, two).level, "probable", "year unknown, two sources, titles agree")
  assert.equal(linkEvidence(k, { ...noYear, titles: ["Something Else 2nd Season"] }, two).level, "insufficient")
})

test("staged search stops early and respects JK_MAX_QUERIES", async () => {
  const calls = []
  installFakeNet({ calls })
  await resolve("series", "tt7441658:1:1")
  const searches = calls.filter((u) => u.includes("/buscar/"))
  assert.equal(searches.length, 1, `Black Clover needs one query: ${searches}`)

  resetAll()
  process.env.JK_MAX_QUERIES = "2"
  const calls2 = []
  installFakeNet({ calls: calls2, anime: { "saijo-no-osewa": { ...RICH, title: "Saijo no Osewa" } } })
  await assert.rejects(resolve("series", "kitsu:50761:1"), { code: "ANIME_NOT_FOUND" })
  assert.ok(calls2.filter((u) => u.includes("/buscar/")).length <= 2)
})

test("a changed search page is reported as such, not as 'not found'", async () => {
  installFakeNet({ searchPage: () => "<html><body><h1>Mantenimiento</h1></body></html>" })
  await assert.rejects(resolve("series", "kitsu:44629:1"), { code: "PARSER_CHANGED" })
})

test("a Cloudflare challenge stops the search at the first query", async () => {
  const calls = []
  installFakeNet({ blocked: true, calls })
  await assert.rejects(resolve("series", "kitsu:50761:1"), { name: "BlockedError" })
  assert.equal(calls.filter((u) => u.includes("jkanime.net")).length, 1)
})
