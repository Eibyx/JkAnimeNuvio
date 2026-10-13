/**
 * Regression for kitsu:49883:1 (Aoashi 2nd Season, 2026). Kitsu only knows
 * "Aoashi 2nd Season", JKAnime calls it "Ao Ashi Season 2", and v0.2.0
 * logged `targets=["Aoashi 2nd Season"] year=2026 candidates=[]`.
 * Kitsu, AniList, yuna and ani.zip fixtures are real responses; the JKAnime
 * site is the usual synthetic double (literal word search, like the failure).
 */
const { test, beforeEach, afterEach } = require("node:test")
const assert = require("node:assert/strict")
const { installFakeNet, resetAll, DEFAULT_ANIME } = require("../test-support/helpers")
const { resolve, buildQueries } = require("../lib/identification/resolver")
const { scoreTitle, similarity } = require("../lib/identification/titles")
const { classifyFailure } = require("../lib/stremio/streams")

beforeEach(resetAll)
afterEach(resetAll)

const pick = ({ slug, episode }) => ({ slug, episode })

test("reproduction: the literal Kitsu title finds nothing on JKAnime (v0.2.0 behaviour)", async () => {
  installFakeNet()
  const site = require("../lib/jkanime/site")
  assert.deepEqual(await site.search("aoashi 2nd season"), [])
  // ...while the base title with JKAnime's spacing lists both seasons.
  assert.deepEqual((await site.search("ao ashi")).map((r) => r.slug).sort(), ["ao-ashi", "ao-ashi-season-2"])
})

test("kitsu:49883:1 resolves to ao-ashi-season-2 episode 1", async () => {
  installFakeNet()
  assert.deepEqual(pick(await resolve("series", "kitsu:49883:1")), { slug: "ao-ashi-season-2", episode: 1 })
})

test("the same entry by anilist:191788 and mal:61603", async () => {
  installFakeNet()
  assert.deepEqual(pick(await resolve("series", "anilist:191788:2")), { slug: "ao-ashi-season-2", episode: 2 })
  assert.deepEqual(pick(await resolve("series", "mal:61603:1")), { slug: "ao-ashi-season-2", episode: 1 })
})

test("season 2 is never served from the season 1 entry", async () => {
  const anime = { ...DEFAULT_ANIME }
  delete anime["ao-ashi-season-2"]
  installFakeNet({ anime })
  await assert.rejects(resolve("series", "kitsu:49883:1"), /no JKAnime entry/)
})

test("a cross-database link to another season (different year) is ignored", async () => {
  // Kitsu mappings pointing at the 2022 season-1 entry must not add "Aoashi".
  installFakeNet({
    kitsu: { "kitsu:mappings:49883": { data: [{ type: "mappings", attributes: { externalSite: "anilist/anime", externalId: "134732" } }] } },
    relations: { "yuna:kitsu:49883": null, "anizip:kitsu_id:49883": null },
  })
  const r = await resolve("series", "kitsu:49883:1").catch((e) => e)
  // Only the Kitsu title is left; whatever happens, it is never the 2022 entry.
  assert.notEqual(r.slug, "ao-ashi")
})

test("without yuna and ani.zip only spelling 'Aoashi' is known: clean miss, never season 1", async () => {
  // Kitsu's own mapping still adds AniList's "Aoashi Season 2", but no source
  // spells it "Ao Ashi" and the fake JKAnime search is literal.
  installFakeNet({ down: ["yuna", "ani.zip"] })
  await assert.rejects(resolve("series", "kitsu:49883:1"), /no JKAnime entry/)
})

test("queries: base titles first, then the full titles", () => {
  const q = buildQueries(["Aoashi 2nd Season", "Aoashi Season 2", "Ao Ashi S2"])
  assert.deepEqual(q.slice(0, 2), ["aoashi", "ao ashi"])
  assert.ok(q.includes("aoashi 2nd season") && q.includes("ao ashi s2"))
  assert.ok(q.length <= 6)
})

test("title equivalences: spacing and season markers", () => {
  assert.equal(similarity("ao ashi", "aoashi"), 1)
  assert.equal(similarity("dragon ball", "dragonball"), 1)
  for (const variant of ["Aoashi 2nd Season", "Aoashi Season 2", "Ao Ashi S2", "Ao Ashi 2nd Season", "Aoashi 2"]) {
    assert.equal(scoreTitle("Ao Ashi Season 2", { title: variant }), 1, variant)
    assert.equal(scoreTitle("Ao Ashi", { title: variant }), 0, `${variant} must not match season 1`)
  }
  // Spacing equality is exact only: short or different words do not collapse.
  assert.ok(similarity("one", "o ne") < 0.88)
  assert.ok(scoreTitle("Ao no Exorcist", { title: "Aoashi" }) < 0.88)
})

test("server failures after identification are classified, not treated as 'not found'", () => {
  assert.equal(classifyFailure({ status: 404 }), "removed")
  assert.equal(classifyFailure({ status: 410 }), "removed")
  assert.equal(classifyFailure({ name: "BlockedError", status: 403 }), "blocked")
  assert.equal(classifyFailure(new Error("Streamtape timed out after 12000 ms")), "timeout")
  assert.equal(classifyFailure({ status: 502 }), "server-error")
})
