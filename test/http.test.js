/**
 * Security of the HTTP layer (lib/utils/http.js). Offline: a fake fetch or a
 * local server; the fake fetch records every URL the addon tried to reach.
 */
const { test, afterEach } = require("node:test")
const assert = require("node:assert/strict")
const nodeHttp = require("node:http")
const http = require("../lib/utils/http")
const { isBlockedIp } = require("../lib/utils/ip")
const { withContext } = require("../lib/utils/context")

afterEach(() => http.resetFetch())

const reply = (body, { status = 200, headers = {}, url } = {}) => ({
  ok: status >= 200 && status < 300, status, url, headers: new Headers(headers),
  text: async () => body, body: null,
})

/** Fake fetch from a table of url -> response factory; records requests. */
function fakeNet(routes) {
  const seen = []
  http.setFetch(async (href, opts) => {
    seen.push({ href, headers: { ...opts.headers }, method: opts.method, redirect: opts.redirect })
    const route = routes[href]
    if (!route) throw new Error(`unexpected request ${href}`)
    return route(opts)
  })
  return seen
}

test("special IPv4 and IPv6 ranges are blocked, public ones are not", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "198.18.0.1", "192.0.2.1", "203.0.113.5", "224.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::7f00:1", "64:ff9b::7f00:1", "64:ff9b:1::1",
    "2002:7f00:1::", "2001:db8::1", "2001::1", "fc00::1", "fd12::1", "fe80::1", "fec0::1", "ff02::1", "100::1"]) {
    assert.equal(isBlockedIp(ip), true, ip)
  }
  for (const ip of ["8.8.8.8", "104.21.0.1", "2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::"]) {
    assert.equal(isBlockedIp(ip), false, ip)
  }
})

test("safeUrl rejects internal targets in every spelling", () => {
  for (const u of [
    "http://[::ffff:127.0.0.1]/", "http://[::ffff:a9fe:a9fe]/latest/meta-data", "http://[64:ff9b::7f00:1]/",
    "http://[::7f00:1]/", "http://[fe80::1]/", "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/",
    "http://router/", "http://nas.lan/", "http://printer.home.arpa/", "http://localhost./", "http://127.1/",
    "file:///etc/passwd", "ftp://example.com/", "https://user:pass@example.com/", "not a url",
  ]) {
    assert.equal(http.safeUrl(u), null, u)
  }
  assert.ok(http.safeUrl("https://jkanime.net/ao-ashi/"))
  assert.ok(http.safeUrl("http://[2606:4700::1111]/"))
})

test("redirects are validated before connecting: an internal hop is never requested", async () => {
  const seen = fakeNet({
    "https://video.example/e/1": () => reply("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }),
  })
  await assert.rejects(http.request("https://video.example/e/1"), { code: "UNSAFE_URL" })
  assert.deepEqual(seen.map((s) => s.href), ["https://video.example/e/1"])
  assert.equal(seen[0].redirect, "manual")
})

test("redirect chains: relative hops, the hop limit and cross-origin credentials", async () => {
  const seen = fakeNet({
    "https://a.example/start": () => reply("", { status: 301, headers: { location: "/next" } }),
    "https://a.example/next": () => reply("", { status: 307, headers: { location: "https://b.example/final?sig=abc" } }),
    "https://b.example/final?sig=abc": () => reply("ok"),
  })
  const r = await http.request("https://a.example/start", { headers: { Authorization: "Bearer secret", Cookie: "s=1" } })
  assert.equal(r.text, "ok")
  assert.equal(r.url, "https://b.example/final?sig=abc")
  assert.equal(seen[1].headers.Authorization, "Bearer secret", "same origin keeps credentials")
  assert.equal(seen[2].headers.Authorization, undefined, "other origin never sees them")
  assert.equal(seen[2].headers.Cookie, undefined)

  const loop = {}
  for (let i = 0; i < 10; i++) loop[`https://loop.example/${i}`] = () => reply("", { status: 302, headers: { location: `/${i + 1}` } })
  fakeNet(loop)
  await assert.rejects(http.request("https://loop.example/0"), { code: "TOO_MANY_REDIRECTS" })
})

test("303 and POST-302 continue as GET without a body", async () => {
  const seen = fakeNet({
    "https://a.example/post": () => reply("", { status: 303, headers: { location: "/result" } }),
    "https://a.example/result": () => reply("done"),
  })
  await http.request("https://a.example/post", { method: "POST", body: "x=1", headers: { "Content-Type": "application/x-www-form-urlencoded" } })
  assert.equal(seen[1].method, "GET")
  assert.equal(seen[1].headers["Content-Type"], undefined)
})

test("DNS rebinding: a public-looking name resolving to a private IP is refused", async () => {
  const seen = fakeNet({ "https://evil.example/": () => reply("internal") })
  http.setLookup(async () => [{ address: "93.184.215.14", family: 4 }, { address: "10.0.0.5", family: 4 }])
  await assert.rejects(http.request("https://evil.example/"), { code: "UNSAFE_URL" })
  assert.equal(seen.length, 0)
  http.setLookup(async () => [{ address: "::ffff:192.168.0.1", family: 6 }])
  await assert.rejects(http.request("https://evil.example/"), { code: "UNSAFE_URL" })
  http.setLookup(async () => [{ address: "93.184.215.14", family: 4 }])
  assert.equal((await http.request("https://evil.example/")).text, "internal")
})

test("redirect hops are DNS-checked too", async () => {
  const seen = fakeNet({
    "https://ok.example/": () => reply("", { status: 302, headers: { location: "https://rebind.example/" } }),
    "https://rebind.example/": () => reply("internal"),
  })
  http.setLookup(async (host) => [{ address: host === "rebind.example" ? "127.0.0.1" : "93.184.215.14", family: 4 }])
  await assert.rejects(http.request("https://ok.example/"), { code: "UNSAFE_URL" })
  assert.deepEqual(seen.map((s) => s.href), ["https://ok.example/"])
})

test("huge responses are cut while streaming, and refused by Content-Length", async () => {
  let pulled = 0
  const chunk = new Uint8Array(1024 * 1024)
  fakeNet({
    "https://big.example/stream": () => ({
      ok: true, status: 200, headers: new Headers(),
      body: new ReadableStream({ pull(c) { pulled++; c.enqueue(chunk) } }),
    }),
    "https://big.example/declared": () => ({ ...reply("x"), headers: new Headers({ "content-length": String(50 * 1024 * 1024) }) }),
  })
  await assert.rejects(http.request("https://big.example/stream"), { code: "TOO_LARGE" })
  assert.ok(pulled <= 8, `stopped reading after ${pulled} MB`)
  await assert.rejects(http.request("https://big.example/declared"), { code: "TOO_LARGE" })
})

test("timeouts abort the connection and a body that never ends", async () => {
  let aborted = 0
  fakeNet({
    "https://slow.example/headers": (opts) => new Promise((_, reject) => opts.signal.addEventListener("abort", () => { aborted++; reject(opts.signal.reason) })),
    "https://slow.example/body": (opts) => {
      opts.signal.addEventListener("abort", () => aborted++)
      return { ok: true, status: 200, headers: new Headers(), body: new ReadableStream({ pull: () => new Promise(() => {}) }) }
    },
  })
  const t0 = Date.now()
  await assert.rejects(http.request("https://slow.example/headers", { timeout: 50 }), { code: "TIMEOUT" })
  await assert.rejects(http.request("https://slow.example/body", { timeout: 50 }), { code: "TIMEOUT" })
  assert.equal(aborted, 2)
  assert.ok(Date.now() - t0 < 2000)
})

test("an aborted request context cancels pending requests", async () => {
  let aborted = false
  fakeNet({ "https://slow.example/x": (opts) => new Promise((_, reject) => opts.signal.addEventListener("abort", () => { aborted = true; reject(opts.signal.reason) })) })
  const ctl = new AbortController()
  const p = withContext({ signal: ctl.signal }, () => http.request("https://slow.example/x", { timeout: 10000 }))
  setTimeout(() => ctl.abort(new http.HttpError("extractor timed out", 0, undefined, "TIMEOUT")), 20)
  await assert.rejects(p, { code: "TIMEOUT" })
  assert.equal(aborted, true)
})

test("at most 4 requests in flight per host", async () => {
  let active = 0
  let peak = 0
  const routes = {}
  for (let i = 0; i < 12; i++) {
    routes[`https://busy.example/${i}`] = async () => {
      active++; peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      return reply("ok")
    }
  }
  fakeNet(routes)
  await Promise.all(Object.keys(routes).map((u) => http.request(u)))
  assert.ok(peak <= 4, `peak ${peak}`)
})

test("errors and logs never carry credentials or signed query strings", async () => {
  fakeNet({ "https://cdn.example/v.m3u8?token=abc&expires=1&sig=zzz": () => reply("gone", { status: 404 }) })
  const err = await http.request("https://cdn.example/v.m3u8?token=abc&expires=1&sig=zzz").catch((e) => e)
  assert.equal(err.code, "HTTP_404")
  assert.doesNotMatch(err.message + err.url, /abc|zzz|expires/)
  assert.equal(http.logUrl("https://x.example/a/b?e=1&t=2"), "https://x.example/a/b?…")
  assert.equal(http.redactUrl("https://x.example/?api_key=k1&key=k2&sig=s&b=1"), "https://x.example/?api_key=***&key=***&sig=***&b=1")
})

test("HTTP status codes map to stable error codes", async () => {
  const routes = {}
  for (const s of [404, 419, 429, 500, 503, 403]) routes[`https://s.example/${s}`] = () => reply("x", { status: s })
  fakeNet(routes)
  const code = (s) => http.request(`https://s.example/${s}`, { retries429: 0 }).catch((e) => e.code)
  assert.deepEqual(await Promise.all([404, 419, 429, 500, 503, 403].map(code)), ["HTTP_404", "HTTP_419", "HTTP_429", "HTTP_5XX", "HTTP_5XX", "HTTP_403"])
})

test("real fetch: an internal URL is refused before any connection", async () => {
  http.resetFetch()
  let hits = 0
  const server = nodeHttp.createServer((_q, s) => { hits++; s.end("secret") }).listen(0, "127.0.0.1")
  await new Promise((r) => server.once("listening", r))
  try {
    const port = server.address().port
    for (const u of [`http://127.0.0.1:${port}/`, `http://[::ffff:127.0.0.1]:${port}/`, `http://localhost:${port}/`]) {
      await assert.rejects(http.request(u), { code: "UNSAFE_URL" }, u)
    }
  } finally {
    server.close()
  }
  assert.equal(hits, 0)
})
