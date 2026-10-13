const { test, before, after, beforeEach } = require("node:test")
const assert = require("node:assert/strict")
const { installFakeNet, resetAll } = require("./helpers")
const { createApp } = require("../lib/app")

let server
let base
before(async () => {
  server = createApp().listen(0, "127.0.0.1")
  await new Promise((r) => server.once("listening", r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => { server.close(); resetAll() })
beforeEach(resetAll)

// The fake fetch only replaces the addon's outgoing requests; these calls hit
// the real local HTTP server through Node's own fetch.
const get = (path) => fetch(base + path)

test("manifest is stream-only and Stremio-shaped", async () => {
  const res = await get("/manifest.json")
  assert.equal(res.status, 200)
  assert.equal(res.headers.get("access-control-allow-origin"), "*")
  assert.match(res.headers.get("content-type"), /application\/json/)
  const m = await res.json()
  for (const key of ["id", "version", "name", "description", "resources", "types", "catalogs"]) assert.ok(key in m, key)
  assert.match(m.id, /^[a-z0-9.]+$/)
  assert.match(m.version, /^\d+\.\d+\.\d+$/)
  assert.deepEqual(m.catalogs, [])
  assert.deepEqual(m.resources.map((r) => r.name || r), ["stream"])
  assert.ok(m.resources[0].idPrefixes.includes("tt"))
  assert.ok(!JSON.stringify(m).includes("meta\""))
  assert.equal(m.behaviorHints.configurable, false)
})

test("configured manifest for TMDB numbering", async () => {
  const m = await (await get("/numbering=tmdb/manifest.json")).json()
  assert.equal(m.id, "com.eibyx.jkanimenuvio.tmdb")
  assert.deepEqual(m.catalogs, [])
})

test("catalog and meta routes do not exist", async () => {
  for (const path of ["/catalog/series/jkanime.json", "/meta/series/tt7441658.json", "/catalog/anime/top/search=naruto.json"]) {
    assert.equal((await get(path)).status, 404, path)
  }
})

test("stream for Black Clover S1E5: direct URLs only, valid Stremio stream objects", async () => {
  installFakeNet()
  const res = await get("/stream/series/tt7441658:1:5.json")
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.ok(Array.isArray(body.streams))
  assert.equal(body.cacheMaxAge, 600)
  const urls = body.streams.map((s) => s.url)
  assert.deepEqual(urls, [
    "https://cdn.jkdesa.com/hls/black-clover-tv-5/master.m3u8",
    "https://vidcache.net:8161/a20260101/v/black-clover-tv5.mp4",
    "https://swcdn.example.net/hls2/black-clover-tv5/master.m3u8?t=1",
    "https://a4.mp4upload.com:183/d/black-clover-tv5/video.mp4",
  ])
  for (const s of body.streams) {
    assert.equal(typeof s.url, "string")
    assert.match(s.url, /^https:\/\//)
    assert.match(s.url, /\.(m3u8|mp4)(\?|$)/)
    assert.ok(!("externalUrl" in s) && !("ytId" in s) && !("infoHash" in s))
    assert.equal(typeof s.name, "string")
    assert.equal(typeof s.description, "string")
    assert.match(s.description, /Black Clover T1 E5/)
    assert.equal(s.behaviorHints.notWebReady, true)
    assert.equal(typeof s.behaviorHints.proxyHeaders.request["User-Agent"], "string")
    assert.equal(typeof s.behaviorHints.bingeGroup, "string")
  }
  assert.ok(body.streams.at(-1).name.endsWith("LAT"), "Latino dub goes last")
  assert.ok(!urls.some((u) => /mega\.nz|dood|127\.0\.0\.1/.test(u)))
})

test("stream for Black Clover S2E1 uses the 2026 season entry", async () => {
  installFakeNet()
  const body = await (await get("/stream/series/tt7441658%3A2%3A1.json")).json()
  assert.ok(body.streams.length > 0)
  assert.ok(body.streams.every((s) => s.url.includes("black-clover-2nd-season")))
})

test("stream with extra args path segment is accepted", async () => {
  installFakeNet()
  const body = await (await get("/stream/series/tt7441658:1:5/videoHash=abc&videoSize=1.json")).json()
  assert.ok(body.streams.length > 0)
})

test("episode that JKAnime does not have yet returns an empty list", async () => {
  installFakeNet()
  const body = await (await get("/stream/series/tt7441658:2:3.json")).json()
  assert.deepEqual(body.streams, [])
  assert.equal(body.cacheMaxAge, 60)
})

test("Cloudflare-blocked JKAnime yields an empty list, not an error", async () => {
  installFakeNet({ blocked: true })
  const res = await get("/stream/series/tt7441658:1:1.json")
  assert.equal(res.status, 200)
  assert.deepEqual((await res.json()).streams, [])
})

test("bad type or id yields an empty list", async () => {
  installFakeNet()
  assert.deepEqual((await (await get("/stream/channel/tt7441658:1:1.json")).json()).streams, [])
  assert.deepEqual((await (await get("/stream/series/notanid.json")).json()).streams, [])
})

test("responses are cached per id", async () => {
  const calls = installFakeNet()
  await get("/stream/series/tt7441658:1:7.json")
  const n = calls.length
  await get("/stream/series/tt7441658:1:7.json")
  assert.equal(calls.length, n)
})
