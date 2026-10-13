const { test, beforeEach, afterEach } = require("node:test")
const assert = require("node:assert/strict")
const { installFakeNet, resetAll, DEFAULT_ANIME, setCredentials } = require("../test-support/helpers")
const { resolve } = require("../lib/resolver")
const common = require("../lib/providers/common")

beforeEach(resetAll)
afterEach(resetAll)

test("Cinemeta layout of Black Clover (real fixture): S1=170, S2=13 from 2026, specials in S0", () => {
  const layout = common.seasonLayout(require("./fixtures/cinemeta-black-clover.json").meta.videos)
  assert.equal(layout[1].count, 170)
  assert.equal(layout[1].startYear, 2017)
  assert.equal(layout[2].count, 13)
  assert.equal(layout[2].startYear, 2026)
  assert.ok(layout[0].count > 0)
})

test("Black Clover S1E1 / S1E170 map to the 170-episode entry", async () => {
  installFakeNet()
  assert.deepEqual(
    (({ slug, episode, via }) => ({ slug, episode, via }))(await resolve("series", "tt7441658:1:1")),
    { slug: "black-clover-tv", episode: 1, via: "season/cinemeta" })
  assert.equal((await resolve("series", "tt7441658:1:170")).episode, 170)
})

test("Black Clover S2E1 maps to the 2026 season, not to episode 1 or 171 of the TV entry", async () => {
  installFakeNet()
  const r = await resolve("series", "tt7441658:2:1")
  assert.equal(r.slug, "black-clover-2nd-season")
  assert.equal(r.episode, 1)
})

test("Black Clover S2E1 without a season-2 entry on JKAnime returns nothing (171 > 170)", async () => {
  const anime = { ...DEFAULT_ANIME }
  delete anime["black-clover-2nd-season"]
  installFakeNet({ anime })
  await assert.rejects(resolve("series", "tt7441658:2:1"), /only has 170 episodes/)
})

test("Black Clover S0 specials are never mapped silently", async () => {
  installFakeNet()
  await assert.rejects(resolve("series", "tt7441658:0:1"), /season 0/)
})

test("TMDB numbering: Black Clover S2E1 (2018) is absolute episode 52 of the TV entry", async () => {
  setCredentials({ tvdb: false })
  installFakeNet()
  // TMDB (synthetic fixture) splits the 170 episodes in 4 seasons.
  const r = await resolve("series", "tt7441658:2:1", { numbering: "tmdb" })
  assert.deepEqual([r.slug, r.episode, r.via], ["black-clover-tv", 52, "absolute/tmdb"])
  const last = await resolve("series", "tt7441658:4:16", { numbering: "tmdb" })
  assert.deepEqual([last.slug, last.episode], ["black-clover-tv", 170])
})

test("continuous JKAnime entry: S2E3 becomes episode 15 when S1 has 12", async () => {
  installFakeNet({
    anime: { "kaiju-no-8": { title: "Kaiju No. 8", type: "Serie", emitted: "Abr 13 de 2024", episodes: 24, status: "Concluido" } },
    cinemeta: {
      "series/tt9999999": {
        meta: {
          name: "Kaiju No. 8", releaseInfo: "2024-", videos: [
            ...Array.from({ length: 12 }, (_, i) => ({ season: 1, episode: i + 1, released: "2024-04-13T00:00:00.000Z" })),
            ...Array.from({ length: 12 }, (_, i) => ({ season: 2, episode: i + 1, released: "2025-07-19T00:00:00.000Z" })),
          ],
        },
      },
    },
    anilist: { data: { Page: { media: [] } } },
  })
  const r = await resolve("series", "tt9999999:2:3")
  assert.deepEqual([r.slug, r.episode, r.via], ["kaiju-no-8", 15, "absolute/cinemeta"])
})

test("no confident title match returns nothing", async () => {
  installFakeNet({
    cinemeta: { "series/tt1111111": { meta: { name: "Black Bullet", releaseInfo: "2014", videos: [{ season: 1, episode: 1, released: "2014-04-08" }] } } },
    anilist: { data: { Page: { media: [] } } },
  })
  await assert.rejects(resolve("series", "tt1111111:1:1"), /no JKAnime entry/)
})

test("JKAnime Cloudflare challenge surfaces as BlockedError", async () => {
  installFakeNet({ blocked: true })
  await assert.rejects(resolve("series", "tt7441658:1:1"), { name: "BlockedError" })
})

test("kitsu ids use the per-season Kitsu entry and its own episode number", async () => {
  installFakeNet()
  common.cache.set("kitsu:13209", Promise.resolve({ source: "kitsu", id: "13209", format: "TV", episodes: 170, startYear: 2017, titles: ["Black Clover"] }))
  const r = await resolve("series", "kitsu:13209:12")
  assert.deepEqual([r.slug, r.episode], ["black-clover-tv", 12])
})

test("anime movies resolve to the movie entry, not the series", async () => {
  installFakeNet({
    cinemeta: { "movie/tt0000002": { meta: { name: "Black Clover: Sword of the Wizard King", releaseInfo: "2023", type: "movie" } } },
  })
  const r = await resolve("movie", "tt0000002")
  assert.deepEqual([r.slug, r.episode], ["black-clover-mahou-tei-no-ken", 1])
})

test("unsupported ids are rejected", async () => {
  await assert.rejects(resolve("series", "jkanime:black-clover-tv:1"), /unsupported id/)
  await assert.rejects(resolve("series", "tt7441658"), /without season/)
})
