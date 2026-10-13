#!/usr/bin/env node
/**
 * REAL network check (not part of `npm test`): identifies a few ids against the
 * live providers and JKAnime and prints what it got, without hiding failures.
 * Credentials are read from .env / the environment and are never printed.
 * Usage: npm run live-check [-- tt42938834:1:1 anilist:187316:1 ...]
 */
require("dotenv").config()
const { identify } = require("../lib/identification/identity")
const jkanime = require("../lib/jkanime/site")
const { resolve } = require("../lib/identification/resolver")
const { getStreams } = require("../lib/stremio/streams")
const { parseVideoId } = require("../lib/identification/episodes")

const configured = (v) => (process.env[v] ? "configured" : "not set")
const ids = process.argv.slice(2)
const targets = ids.length ? ids : ["tt7441658:1:1", "tt7441658:2:1", "tt42938834:1:1", "anilist:187316:1"]

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
  console.log("Providers:", ["TMDB_API_READ_TOKEN", "TMDB_API_KEY", "TVDB_API_KEY", "TVDB_SUBSCRIBER_PIN"].map((v) => `${v}=${configured(v)}`).join(" "),
    `METADATA_PROVIDER=${process.env.METADATA_PROVIDER || "auto"}`)
  console.log(`JKAnime (${jkanime.JKANIME_BASE}):`)
  await step("search 'black clover'", async () => (await jkanime.search("black clover")).map((r) => r.slug))

  for (const id of targets) {
    console.log(`${id}:`)
    const parsed = parseVideoId(id)
    if (parsed && ["imdb", "tmdb", "tvdb"].includes(parsed.source)) {
      await step("identity", async () => {
        const i = await identify({ [parsed.source]: parsed.id }, "series")
        if (!i) throw new Error("no provider recognises it")
        return { name: i.name, year: i.year, sources: i.sources, ids: i.ids, anilist: i.anilist.map((m) => m.id), evidence: i.evidence }
      })
    }
    const target = await step("resolve", () => resolve("series", id))
    if (target) await step("streams", async () => (await getStreams(target)).map((s) => `${s.name.replace("\n", " ")} ${s.url}`))
  }
})()
