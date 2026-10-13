const { test } = require("node:test")
const assert = require("node:assert/strict")
const { buildSearchPlan, fragmentsOf } = require("../lib/identification/queries")
const { similarity, parseTitle, scoreTitle, mainName } = require("../lib/identification/titles")

// Real Kitsu titles of kitsu:50761.
const RICH_EN = "Rich Girl Caretaker: I'm Secretly the Caregiver of the Most Popular Girl in This Rich Kid School"
const RICH_JP = "Saijo no Osewa: Takane no Hanadarake na Meimonkou de, Gakuin Ichi no Ojousama (Seikatsu Nouryoku Kaimu) wo Kagenagara Osewa suru Koto ni Narimashita"

test("long titles: searchable fragments by rule (main name, combination, subtitle start)", () => {
  const plan = buildSearchPlan({ primary: [RICH_EN, RICH_JP] })
  const all = plan.flatMap((s) => s.queries)
  for (const q of ["rich girl caretaker", "saijo no osewa", "saijo no osewa takane no hanadarake", "takane no hanadarake"]) {
    assert.ok(all.includes(q), q)
  }
  // Whole sentences are not sent to JKAnime.
  assert.ok(all.every((q) => q.split(" ").length <= 8), all.join(" | "))
  assert.equal(plan.at(-1).stage, "fragments")
  // Non-distinctive starts ("im secretly the") are not queries.
  assert.ok(!all.some((q) => q.startsWith("im secretly")))
})

test("stages: own titles, then alternatives, then romanisation variants, then fragments", () => {
  const plan = buildSearchPlan({ primary: ["Koori no Jyouheki"], alternatives: ["The Ramparts of Ice"] })
  assert.deepEqual(plan.map((s) => s.stage), ["titles", "alternatives", "variants"])
  assert.deepEqual(plan[2].queries, ["koori no jouheki", "koori no joheki"])
  const ao = buildSearchPlan({ primary: ["Aoashi 2nd Season"], alternatives: ["Ao Ashi S2"] })
  assert.deepEqual(ao[0].queries, ["aoashi", "aoashi 2nd season"])
  assert.deepEqual(ao[1].queries, ["ao ashi", "ao ashi s2"])
})

test("fragments come from punctuation, not from a fixed list", () => {
  assert.deepEqual(fragmentsOf("Black Clover").main, [])
  assert.equal(mainName("Black Clover: Mahou Tei no Ken"), "black clover")
  assert.equal(mainName("Re:Zero kara Hajimeru Isekai Seikatsu"), null, "a one-word first segment is not a main name")
  assert.deepEqual(fragmentsOf("Ore no Imouto ga Konna ni Kawaii Wake ga Nai").main, [])
})

test("romanisation variants are the same title, other words are not", () => {
  assert.equal(similarity("koori no jyouheki", "koori no jouheki"), 1)
  assert.equal(similarity("ojousama", "ojou sama"), 1)
  assert.equal(similarity("shoujo", "shojo"), 1)
  assert.ok(similarity("koori no jouheki", "koori no hanadarake") < 0.88)
  assert.equal(scoreTitle("Koori no Jouheki 2nd Season", { title: "Koori no Jyouheki", season: 2, canonical: true }), 1)
  assert.equal(scoreTitle("Koori no Jouheki", { title: "Koori no Jyouheki", season: 2, canonical: true }), 0)
})

test("a year in parentheses is a remake marker, not part of the name", () => {
  assert.deepEqual([parseTitle("Fruits Basket (2019)").base, parseTitle("Fruits Basket (2019)").year], ["fruits basket", 2019])
  assert.equal(scoreTitle("Fruits Basket (2019)", { title: "Fruits Basket" }), 1)
  assert.equal(parseTitle("Blade Runner 2049").year, null)
})
