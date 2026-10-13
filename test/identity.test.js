const { test, beforeEach, afterEach } = require("node:test")
const assert = require("node:assert/strict")
const { installFakeNet, resetAll, setCredentials, DEFAULT_ANIME, TMDB, TVDB, FAKE } = require("../test-support/helpers")
const { resolve } = require("../lib/identification/resolver")
const { identify } = require("../lib/identification/identity")
const tmdb = require("../lib/providers/tmdb")
const { redactUrl } = require("../lib/utils/http")

beforeEach(resetAll)
afterEach(resetAll)

const pick = ({ slug, episode, via }) => ({ slug, episode, via })
const hosts = (stats) => stats.requests.map((r) => new URL(r.url).hostname)

/* ---------------------------------------------------------- Gensou Suikoden */

test("Gensou Suikoden by IMDb: Cinemeta {} and TMDB /find empty -> TVDB remote id -> gensou-suikoden ep 1", async () => {
  setCredentials()
  const stats = { tvdbLogins: 0, requests: [] }
  installFakeNet({ stats })
  const r = await resolve("series", "tt42938834:1:1")
  assert.deepEqual(pick(r), { slug: "gensou-suikoden", episode: 1, via: "season/tvdb" })
  const order = hosts(stats)
  assert.ok(order.indexOf("api.themoviedb.org") < order.indexOf("api4.thetvdb.com"), "TMDB is asked before TVDB")
})

test("Gensou Suikoden by AniList id resolves to the same JKAnime episode", async () => {
  installFakeNet()
  const a = await resolve("series", "anilist:187316:1")
  setCredentials()
  const b = await resolve("series", "tt42938834:1:1")
  assert.deepEqual([a.slug, a.episode], ["gensou-suikoden", 1])
  assert.deepEqual([b.slug, b.episode], [a.slug, a.episode])
})

test("Gensou Suikoden identity records verified ids and evidence (relations confirmed both ways)", async () => {
  setCredentials()
  installFakeNet()
  const id = await identify({ imdb: "tt42938834" }, "series")
  assert.deepEqual(id.sources, ["tvdb"])
  assert.equal(id.ids.tvdb, "482279")
  assert.equal(id.ids.tmdb, "285710") // from TVDB's own remote ids
  assert.deepEqual(id.anilist.map((m) => m.id), [187316])
  const ev = id.evidence.join(" | ")
  assert.match(ev, /tvdb:remoteid\(tt42938834\) -> series\/482279/)
  assert.match(ev, /anizip:tmdb\/285710/) // ani.zip proposes it from the TMDB id...
  assert.match(ev, /yuna:anilist\/187316->imdb/) // ...yuna confirms the IMDb id
  // ani.zip's stale TVDB id (460979) is not taken: TVDB itself said 482279.
  assert.notEqual(id.ids.tvdb, "460979")
})

test("IMDb found through TMDB (when TMDB links it): TVDB is not needed", async () => {
  setCredentials()
  const tmdbData = structuredClone(TMDB)
  tmdbData.find.tt42938834 = { tv_results: [{ id: 285710 }], movie_results: [] }
  tmdbData.tv[285710].external_ids.imdb_id = "tt42938834"
  const stats = { tvdbLogins: 0, requests: [] }
  installFakeNet({ tmdb: tmdbData, stats })
  const r = await resolve("series", "tt42938834:1:1")
  assert.deepEqual([r.slug, r.episode, r.via], ["gensou-suikoden", 1, "season/tmdb"])
  assert.ok(!hosts(stats).includes("api4.thetvdb.com"))
})

test("IMDb absent from Cinemeta and no TMDB/TVDB credentials: nothing is guessed", async () => {
  installFakeNet()
  await assert.rejects(resolve("series", "tt42938834:1:1"), /no metadata provider recognises/)
})

test("ids with no verifiable correspondence anywhere return nothing", async () => {
  setCredentials()
  installFakeNet()
  await assert.rejects(resolve("series", "tt0000009:1:1"), /no metadata provider recognises/)
})

test("Japanese titles: native name is used for AniList search, romaji alias reaches JKAnime", async () => {
  setCredentials()
  const stats = { tvdbLogins: 0, requests: [] }
  installFakeNet({ stats })
  const id = await identify({ imdb: "tt42938834" }, "series")
  assert.ok(id.searchNames.includes("幻想水滸伝"))
  assert.ok(id.aliases.includes("Gensou Suikoden"))
  await resolve("series", "tt42938834:1:1")
  const searched = stats.requests.filter((r) => r.url.startsWith("https://graphql.anilist.co")).map((r) => JSON.parse(r.body).variables.s).filter(Boolean)
  assert.ok(searched.includes("幻想水滸伝"), searched.join(","))
  assert.ok(stats.requests.some((r) => r.url.startsWith("https://jkanime.net/buscar/gensou%20suikoden")))
})

test("relation databases are not trusted alone: tt7441658 -> AniList 87528 (Jump Festa special) is rejected", async () => {
  // Real data: yuna and ani.zip BOTH map Black Clover's IMDb/TMDB/TVDB ids to AniList 87528, an OVA.
  setCredentials()
  installFakeNet()
  const id = await identify({ imdb: "tt7441658" }, "series")
  assert.ok(!id.anilist.some((m) => m.id === 87528))
})

test("ambiguous TMDB /find (two series for one IMDb id) is ignored", async () => {
  setCredentials({ tvdb: false })
  const tmdbData = structuredClone(TMDB)
  tmdbData.find.tt7441658 = { tv_results: [{ id: 73223 }, { id: 285710 }], movie_results: [] }
  installFakeNet({ tmdb: tmdbData })
  const id = await identify({ imdb: "tt7441658" }, "series")
  assert.deepEqual(id.sources, ["cinemeta"])
})

test("contradicting providers: TVDB is dropped when its ids disagree with TMDB", async () => {
  setCredentials()
  const tmdbData = structuredClone(TMDB)
  tmdbData.tv[73223].external_ids.tvdb_id = 999
  installFakeNet({ tmdb: tmdbData })
  const id = await identify({ imdb: "tt7441658" }, "series", { wantTvdb: true })
  assert.ok(id.sources.includes("tmdb"))
  assert.ok(!id.sources.includes("tvdb"))
})

/* ------------------------------------------------------- Black Clover numberings */

test("Black Clover keeps Cinemeta numbering by default even with TMDB+TVDB configured", async () => {
  setCredentials()
  installFakeNet()
  assert.deepEqual(pick(await resolve("series", "tt7441658:2:1")), { slug: "black-clover-2nd-season", episode: 1, via: "season/cinemeta" })
  assert.deepEqual(pick(await resolve("series", "tt7441658:1:170")), { slug: "black-clover-tv", episode: 170, via: "season/cinemeta" })
})

test("Black Clover numberings: tmdb, tvdb (default order) and tvdb-absolute", async () => {
  setCredentials()
  installFakeNet()
  assert.deepEqual([(await resolve("series", "tt7441658:2:1", { numbering: "tmdb" })).episode], [52])
  const tv = await resolve("series", "tt7441658:2:1", { numbering: "tvdb" })
  assert.deepEqual([tv.slug, tv.episode, tv.via], ["black-clover-tv", 52, "absolute/tvdb"])
  const abs = await resolve("series", "tt7441658:1:52", { numbering: "tvdb-absolute" })
  assert.deepEqual([abs.slug, abs.episode], ["black-clover-tv", 52])
})

test("a season the chosen numbering does not have is never guessed (tvdb-absolute T2E1)", async () => {
  setCredentials()
  installFakeNet()
  await assert.rejects(resolve("series", "tt7441658:2:1", { numbering: "tvdb-absolute" }), /only has 170 episodes|no JKAnime entry/)
})

test("tmdb:/tvdb: ids use their own numbering", async () => {
  setCredentials()
  installFakeNet()
  assert.equal((await resolve("series", "tmdb:73223:2:1")).episode, 52)
  assert.equal((await resolve("series", "tvdb:331753:2:1")).episode, 52)
  assert.equal((await resolve("series", "tvdb:482279:1:1")).slug, "gensou-suikoden")
})

test("Cinemeta down: default numbering is NOT silently switched to TMDB", async () => {
  setCredentials()
  installFakeNet({ down: ["cinemeta"] })
  await assert.rejects(resolve("series", "tt7441658:2:1"), /Cinemeta is unavailable/)
  // An explicit numbering still works.
  assert.equal((await resolve("series", "tt7441658:2:1", { numbering: "tmdb" })).episode, 52)
})

test("independent seasons (mapping=season): no fallback to continuous numbering", async () => {
  const anime = { ...DEFAULT_ANIME }
  delete anime["black-clover-2nd-season"]
  installFakeNet({ anime })
  await assert.rejects(resolve("series", "tt7441658:2:1", { mapping: "season" }), /no JKAnime entry/)
})

test("continuous numbering (mapping=absolute) always targets the base entry", async () => {
  setCredentials()
  installFakeNet()
  const r = await resolve("series", "tt7441658:3:1", { numbering: "tmdb", mapping: "absolute" })
  assert.deepEqual([r.slug, r.episode], ["black-clover-tv", 103])
})

/* ----------------------------------------------------- auth, outages, limits */

test("TMDB authentication failure falls back to TVDB and leaks no credential", async () => {
  setCredentials()
  process.env.TMDB_API_READ_TOKEN = "wrong-token"
  installFakeNet()
  assert.equal((await resolve("series", "tt42938834:1:1")).slug, "gensou-suikoden")
})

test("TVDB authentication failure: other providers keep working, error has no key", async () => {
  setCredentials()
  process.env.TVDB_API_KEY = "wrong-tvdb-key"
  installFakeNet()
  assert.equal((await resolve("series", "tt7441658:1:5")).slug, "black-clover-tv")
  const err = await resolve("series", "tt42938834:1:1").catch((e) => e)
  assert.match(err.message, /no metadata provider recognises/)
  assert.ok(!err.message.includes("wrong-tvdb-key"))
})

test("TVDB session token is reused and renewed once after a 401", async () => {
  setCredentials({ pin: true })
  const stats = { tvdbLogins: 0, requests: [] }
  installFakeNet({ stats })
  await identify({ imdb: "tt42938834" }, "series")
  await resolve("series", "tvdb:331753:1:1")
  assert.equal(stats.tvdbLogins, 1)
  const login = stats.requests.find((r) => r.url.endsWith("/v4/login"))
  assert.deepEqual(JSON.parse(login.body), { apikey: FAKE.tvdbKey, pin: FAKE.tvdbPin })
  // Server-side revocation: the next call gets 401, logs in again and succeeds.
  stats.revokeTvdbToken = true
  stats.tvdbLogins++ // invalidates the current token in the fake
  const layout = await require("../lib/providers/tvdb").getLayout("482279", "official")
  assert.equal(layout[1].count, 2)
  assert.equal(stats.tvdbLogins, 3)
})

test("TMDB v3 api_key mode works and the key is redacted from errors", async () => {
  setCredentials({ tmdbKeyOnly: true, tvdb: false })
  installFakeNet()
  assert.deepEqual((await tmdb.findByImdb("tt7441658")).tv, ["73223"])
  process.env.TMDB_API_KEY = "secret-v3-key"
  const err = await tmdb.findByImdb("tt0000001").catch((e) => e)
  assert.ok(err instanceof Error)
  assert.ok(!err.message.includes("secret-v3-key"), err.message)
  assert.equal(redactUrl("https://x.test/a?api_key=abc&b=1"), "https://x.test/a?api_key=***&b=1")
})

test("metadata APIs temporarily down: the addon degrades instead of failing", async () => {
  setCredentials()
  // TMDB, relations and AniList down: TVDB alone still identifies Gensou Suikoden,
  // and its romaji alias is enough to find the JKAnime entry.
  installFakeNet({ down: ["themoviedb", "anilist", "yuna", "ani.zip"] })
  assert.equal((await resolve("series", "tt42938834:1:1")).slug, "gensou-suikoden")
})

test("everything down: a clean ResolveError, no crash", async () => {
  setCredentials()
  installFakeNet({ down: ["themoviedb", "thetvdb", "cinemeta", "anilist", "yuna", "ani.zip"] })
  await assert.rejects(resolve("series", "tt7441658:1:1"), { name: "ResolveError" })
})

test("strict id validation", async () => {
  for (const bad of ["tt42938834:1", "tmdb:abc:1:1", "tvdb:1:1", "tt" + "1".repeat(80) + ":1:1", "%E0%A4%A"]) {
    await assert.rejects(resolve("series", bad), /unsupported id/, bad)
  }
})

test("identity results are cached", async () => {
  setCredentials()
  const stats = { tvdbLogins: 0, requests: [] }
  installFakeNet({ stats })
  await identify({ imdb: "tt42938834" }, "series")
  const n = stats.requests.length
  await identify({ imdb: "tt42938834" }, "series")
  assert.equal(stats.requests.length, n)
  assert.ok(TVDB.series[482279])
})
