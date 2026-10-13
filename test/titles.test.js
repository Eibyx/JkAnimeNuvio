const { test } = require("node:test")
const assert = require("node:assert/strict")
const { parseTitle, scoreTitle, normalize, isLatinTitle } = require("../lib/identification/titles")
const { parseVideoId, toAbsolute } = require("../lib/identification/episodes")

test("normalize strips accents, punctuation and case", () => {
  assert.equal(normalize("Kimetsu no Yaiba: Yūkaku-hen!"), "kimetsu no yaiba yukaku hen")
  assert.equal(normalize("Fate/Zero"), "fate zero")
})

test("parseTitle extracts season markers", () => {
  assert.deepEqual(
    [parseTitle("Black Clover (TV)").base, parseTitle("Black Clover (TV)").season],
    ["black clover", null])
  for (const t of ["Black Clover 2nd Season", "Black Clover Season 2", "Black Clover 2", "Black Clover II", "Black Clover 2da Temporada", "Black Clover Temporada 2"]) {
    const p = parseTitle(t)
    assert.equal(p.base, "black clover", t)
    assert.equal(p.season, 2, t)
  }
  const aot = parseTitle("Shingeki no Kyojin Season 3 Part 2")
  assert.deepEqual([aot.base, aot.season, aot.part], ["shingeki no kyojin", 3, 2])
  assert.equal(parseTitle("Black Clover: Mahou Tei no Ken").season, null)
  assert.equal(parseTitle("Black Clover: Jump Festa 2016 Special").kind, "special")
  assert.equal(parseTitle("Mob Psycho 100").season, null)
})

test("scoreTitle keeps seasons, movies and specials apart", () => {
  const s1 = { title: "Black Clover", season: 1, canonical: true }
  const s2 = { title: "Black Clover", season: 2, canonical: true }
  assert.ok(scoreTitle("Black Clover (TV)", s1) >= 0.95)
  assert.equal(scoreTitle("Black Clover 2nd Season", s1), 0)
  assert.equal(scoreTitle("Black Clover (TV)", s2), 0)
  assert.ok(scoreTitle("Black Clover 2nd Season", s2) >= 0.95)
  assert.ok(scoreTitle("Black Clover: Mahou Tei no Ken", s1) < 0.88)
  assert.equal(scoreTitle("Black Clover: Jump Festa 2016 Special", s1), 0)
  assert.ok(scoreTitle("Mugyutto! Black Clover", s1) < 0.88)
  assert.ok(scoreTitle("Black Clover: Mahou Tei no Ken", { title: "Black Clover: Mahou Tei no Ken" }, "movie") >= 0.95)
  assert.ok(scoreTitle("Shingeki no Kyojin", { title: "Attack on Titan", season: 1 }) < 0.5)
})

test("isLatinTitle filters non-Latin aliases", () => {
  assert.equal(isLatinTitle("Black Clover"), true)
  assert.equal(isLatinTitle("ブラッククローバー"), false)
  assert.equal(isLatinTitle("Чёрный клевер"), false)
})

test("parseVideoId understands Stremio ids", () => {
  assert.deepEqual(parseVideoId("tt7441658:2:1"), { source: "imdb", id: "tt7441658", season: 2, episode: 1 })
  assert.deepEqual(parseVideoId("tt7441658%3A1%3A5"), { source: "imdb", id: "tt7441658", season: 1, episode: 5 })
  assert.deepEqual(parseVideoId("tt0000001"), { source: "imdb", id: "tt0000001" })
  assert.deepEqual(parseVideoId("kitsu:13209:5"), { source: "kitsu", id: "13209", episode: 5 })
  assert.deepEqual(parseVideoId("mal:34572"), { source: "mal", id: "34572" })
  assert.deepEqual(parseVideoId("tmdb:73223:2:1"), { source: "tmdb", id: "73223", season: 2, episode: 1 })
  assert.equal(parseVideoId("tt7441658:2"), null)
  assert.equal(parseVideoId("jkanime:black-clover-tv:1"), null)
  assert.equal(parseVideoId("../../etc/passwd"), null)
})

test("toAbsolute converts split seasons to continuous numbering", () => {
  const tmdb = { 1: { count: 51 }, 2: { count: 51 }, 3: { count: 52 }, 4: { count: 16 } }
  assert.equal(toAbsolute(tmdb, 1, 5), 5)
  assert.equal(toAbsolute(tmdb, 2, 1), 52)
  assert.equal(toAbsolute(tmdb, 4, 16), 170)
  assert.equal(toAbsolute({ 2: { count: 10 } }, 2, 1), null)
})

test("numbers that belong to the name are not seasons (Kaiju No. 8)", () => {
  assert.equal(scoreTitle("Kaiju No. 8", { title: "Kaiju No. 8", season: 1, canonical: true }), 1)
  assert.equal(scoreTitle("Kaiju No. 8", { title: "Kaiju No. 8", season: 2, canonical: true }), 0)
  assert.equal(scoreTitle("Kaiju No. 8 Season 2", { title: "Kaiju No. 8", season: 2, canonical: true }), 1)
  assert.equal(scoreTitle("Kaiju No. 8 Season 2", { title: "Kaiju No. 8" }), 0)
  assert.equal(scoreTitle("Mob Psycho 100 II", { title: "Mob Psycho 100", season: 2, canonical: true }), 1)
})
