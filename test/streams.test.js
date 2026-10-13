/**
 * Extraction robustness: error codes, real cancellation, Filemoon key sizes,
 * signed-link expiry and the optional link probe. Offline (fake hosts); the
 * Filemoon payloads are generated here with the documented format, not
 * captured from Filemoon.
 */
const { test, beforeEach, afterEach } = require("node:test")
const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const { installFakeNet, resetAll, response, b64 } = require("../test-support/helpers")
const http = require("../lib/utils/http")
const ex = require("../lib/jkanime/extractors")
const streams = require("../lib/stremio/streams")
const { urlExpiry } = require("../lib/utils/expiry")
const { streamsTtl } = require("../lib/app")

beforeEach(resetAll)
afterEach(() => { resetAll(); delete process.env.EXTRACT_TIMEOUT_MS; delete process.env.STREAM_PROBE })

function filemoonPayload(keyBytes, data) {
  const key = crypto.randomBytes(keyBytes)
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv(`aes-${keyBytes * 8}-gcm`, key, iv)
  const enc = Buffer.concat([c.update(JSON.stringify(data)), c.final(), c.getAuthTag()])
  const half = Math.floor(key.length / 2)
  return { key_parts: [key.subarray(0, half), key.subarray(half)].map((k) => k.toString("base64url")), iv: iv.toString("base64url"), payload: enc.toString("base64url") }
}

test("Filemoon: AES-GCM chosen by key size like the reference (16/24/32), other sizes isolated", () => {
  const data = { sources: [{ url: "https://cdn.example.net/hls/master.m3u8", mime_type: "application/vnd.apple.mpegurl" }] }
  for (const n of [16, 24, 32]) assert.deepEqual(ex.decryptFilemoon(filemoonPayload(n, data)), data, `${n} bytes`)
  const bad = filemoonPayload(32, data)
  bad.key_parts = [Buffer.alloc(20).toString("base64url")]
  assert.throws(() => ex.decryptFilemoon(bad), { code: "UNSUPPORTED_FORMAT" })
  const tampered = filemoonPayload(16, data)
  tampered.payload = Buffer.from(tampered.payload, "base64url").fill(1, 0, 4).toString("base64url")
  assert.throws(() => ex.decryptFilemoon(tampered), { code: "UNSUPPORTED_FORMAT" }, "a wrong tag is not silently accepted")
})

test("Filemoon end to end with a 16-byte key", async () => {
  const pb = filemoonPayload(16, { sources: [{ url: "https://cdn.example.net/hls/abc/master.m3u8" }] })
  http.setFetch(async (href) => response({ playback: pb }, { url: href }))
  const out = await ex.extract("https://filemoon.sx/e/abc123", "Filemoon")
  assert.deepEqual(out.map((m) => [m.url, m.kind]), [["https://cdn.example.net/hls/abc/master.m3u8", "hls"]])
})

test("signed-link expiry is read only from explicit formats", () => {
  const now = Date.UTC(2026, 9, 13, 12, 0, 0)
  const unix = now / 1000
  assert.equal(urlExpiry(`https://c.example/v.m3u8?expires=${unix + 600}`, now), (unix + 600) * 1000)
  assert.equal(urlExpiry(`https://c.example/v.m3u8?t=x&s=${unix - 100}&e=3600&f=1`, now), (unix + 3500) * 1000)
  assert.equal(urlExpiry("https://c.example/v.mp4?X-Amz-Date=20261013T120000Z&X-Amz-Expires=900", now), now + 900e3)
  assert.equal(urlExpiry("https://c.example/v.mp4?e=129600", now), null, "a lifetime without its start is unknown")
  assert.equal(urlExpiry("https://c.example/v.mp4?expires=12", now), null, "not a plausible timestamp")
  assert.equal(urlExpiry("https://c.example/v.mp4", now), null)
})

test("cached stream lists never outlive their links", () => {
  const now = Date.now()
  const at = (sec) => ({ url: `https://c.example/v.m3u8?expires=${Math.floor(now / 1000) + sec}` })
  assert.equal(streamsTtl([{ url: "https://c.example/v.mp4" }], now), 10 * 60 * 1000)
  assert.ok(streamsTtl([at(5 * 60), { url: "https://c.example/x.mp4" }], now) <= 3 * 60 * 1000)
  assert.equal(streamsTtl([at(60)], now), 0, "expires within the margin: not cached")
  assert.equal(streamsTtl([], now), 2 * 60 * 1000)
})

const twoServers = (slug, n) => [
  { remote: b64(`https://www.yourupload.com/embed/${slug}${n}`), server: "YourUpload", lang: 1 },
  { remote: b64(`https://www.mp4upload.com/embed-${slug}${n}.html`), server: "Mp4upload", lang: 1 },
]

test("a server that never answers is cancelled at the deadline and the others still return", async () => {
  process.env.EXTRACT_TIMEOUT_MS = "100"
  let aborted = 0
  installFakeNet({
    servers: twoServers,
    intercept: (href, opts) => href.includes("mp4upload")
      && new Promise((_, reject) => opts.signal.addEventListener("abort", () => { aborted++; reject(opts.signal.reason) })),
  })
  const t0 = Date.now()
  const list = await streams.getStreams({ slug: "black-clover-tv", episode: 1, label: "Black Clover E1" })
  assert.ok(Date.now() - t0 < 3000)
  assert.equal(aborted, 1, "the hanging request was aborted, not left running")
  assert.ok(list.some((s) => s.url.includes("vidcache.net")), "YourUpload still returned its link")
  assert.ok(!list.some((s) => s.url.includes("mp4upload")))
})

test("STREAM_PROBE=true drops links that do not answer like media; off by default", async () => {
  const intercept = (href) => {
    if (href.includes("vidcache.net")) return response("not found", { status: 404, url: href })
    if (href.includes("cdn.jkdesa.com")) return response("#EXTM3U\n#EXT-X-VERSION:3\n", { url: href })
    if (href.includes("swcdn.example.net")) return response("<html>error page</html>", { url: href })
    return null
  }
  installFakeNet({ intercept })
  const target = { slug: "black-clover-tv", episode: 1, label: "Black Clover E1" }
  const all = await streams.getStreams(target)
  resetAll()
  process.env.STREAM_PROBE = "true"
  const seen = []
  installFakeNet({ intercept: (href, opts) => { if (/vidcache|jkdesa|swcdn|a4\.mp4upload/.test(href)) seen.push([href, opts.method, opts.headers.Range]); return intercept(href) } })
  const probed = await streams.getStreams(target)
  const hosts = (l) => l.map((s) => new URL(s.url).hostname).sort()
  assert.ok(hosts(all).includes("vidcache.net") && hosts(all).includes("swcdn.example.net"))
  assert.ok(!hosts(probed).includes("vidcache.net"), "MP4 answering 404 dropped")
  assert.ok(!hosts(probed).includes("swcdn.example.net"), "HLS that is not a playlist dropped")
  assert.ok(hosts(probed).includes("cdn.jkdesa.com"))
  assert.ok(seen.every(([, method]) => method === "GET"), "never HEAD")
  assert.ok(seen.filter(([h]) => /\.mp4/.test(h)).every(([, , range]) => range === "bytes=0-0"), "MP4 probes ask for one byte")
})
