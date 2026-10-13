#!/usr/bin/env node
/**
 * REAL network check (not part of `npm test`): resolves a few ids against the
 * live Cinemeta, AniList and JKAnime and prints what it got, without hiding
 * failures. Usage: npm run live-check [-- tt7441658:2:1 ...]
 */
require("dotenv").config()
const metadata = require("../lib/metadata")
const jkanime = require("../lib/jkanime")
const { resolve } = require("../lib/resolver")
const { getStreams } = require("../lib/streams")

const ids = process.argv.slice(2)
const targets = ids.length ? ids : ["tt7441658:1:1", "tt7441658:1:170", "tt7441658:2:1", "tt7441658:0:1"]

async function step(label, fn) {
  try {
    const value = await fn()
    console.log(`  OK   ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    return value
  } catch (err) {
    console.log(`  FAIL ${label}: ${err.name}: ${err.message}`)
    return undefined
  }
}

;(async () => {
  console.log("Cinemeta (real):")
  await step("tt7441658 layout", async () => {
    const m = await metadata.getCinemeta("series", "tt7441658")
    return { name: m.name, seasons: Object.fromEntries(Object.entries(m.layout).map(([s, v]) => [s, `${v.count} eps from ${v.startYear}`])) }
  })
  console.log("AniList (real):")
  await step("search 'Black Clover'", async () => (await metadata.searchAniList("Black Clover"))
    .map((m) => `${m.format} ${m.startYear} ${m.titles[0]}`))
  console.log(`JKAnime (real, ${jkanime.JKANIME_BASE}):`)
  await step("search 'black clover'", async () => (await jkanime.search("black clover")).map((r) => `${r.slug} [${r.type}]`))

  for (const id of targets) {
    console.log(`Resolve ${id} (real):`)
    const target = await step("resolve", () => resolve("series", id))
    if (target) await step("streams", async () => (await getStreams(target)).map((s) => `${s.name.replace("\n", " ")} ${s.url}`))
  }
})()
