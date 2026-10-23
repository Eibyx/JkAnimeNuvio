/**
 * Cloud deployment (Koyeb): optional token, rate limit, public URL behind a
 * proxy, /status, error responses and clean shutdown. With none of the new
 * variables set, the addon must behave exactly as before.
 */
const { test, afterEach } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { spawn } = require("node:child_process")
const { installFakeNet, resetAll, setCredentials, FAKE } = require("../test-support/helpers")
const { createApp, publicBase, trustProxySetting } = require("../lib/app")
const upstream = require("../lib/utils/upstream")
const { HttpError, BlockedError } = require("../lib/utils/http")
const { rateLimit } = require("../lib/utils/ratelimit")

const ROOT = path.join(__dirname, "..")
const TOKEN = "s3cr3t-T0ken_abcdefgh"
// index.js treats PORT=0 as unset (3000), so child servers get a random high port.
const randomPort = () => 40000 + Math.floor(Math.random() * 20000)
const NEW_VARS = ["ADDON_TOKEN", "RATE_LIMIT_PER_MIN", "STATUS_ENABLED", "TRUST_PROXY", "PUBLIC_URL", "CACHE_MAX_ENTRIES"]

afterEach(() => {
  for (const v of NEW_VARS) delete process.env[v]
  resetAll()
  upstream.reset()
})

/** Starts an app with the given environment and returns a GET helper. */
async function serve(env = {}) {
  Object.assign(process.env, env)
  const server = createApp().listen(0, "127.0.0.1")
  await new Promise((r) => server.once("listening", r))
  const base = `http://127.0.0.1:${server.address().port}`
  const get = (p, headers = {}) => fetch(base + p, { headers })
  return { get, close: () => new Promise((r) => server.close(r)) }
}

test("without ADDON_TOKEN, every route stays where it was", async () => {
  const { get, close } = await serve()
  try {
    assert.equal((await get("/manifest.json")).status, 200)
    assert.equal((await get("/numbering=tmdb/manifest.json")).status, 200)
    assert.equal((await get("/")).status, 200)
    assert.equal((await get("/status")).status, 404, "status is off unless STATUS_ENABLED=true")
    assert.deepEqual(await (await get("/health")).json(), { ok: true })
  } finally { await close() }
})

test("with ADDON_TOKEN, manifests and streams only work under /{token}/, including config variants", async () => {
  installFakeNet()
  const { get, close } = await serve({ ADDON_TOKEN: TOKEN })
  try {
    for (const p of ["/manifest.json", "/numbering=tmdb&mapping=absolute/manifest.json", "/stream/series/tt7441658:1:5.json",
      "/numbering=tmdb/stream/series/tt7441658:1:5.json", "/", "/status"]) {
      assert.equal((await get(p)).status, 404, p)
    }
    const m = await (await get(`/${TOKEN}/manifest.json`)).json()
    assert.equal(m.id, "com.eibyx.jkanimenuvio")
    const configured = await (await get(`/${TOKEN}/numbering=tmdb&mapping=absolute/manifest.json`)).json()
    assert.equal(configured.id, "com.eibyx.jkanimenuvio.tmdb.absolute")
    const tv = await (await get(`/${TOKEN}/numbering=tvdb-absolute/manifest.json`)).json()
    assert.equal(tv.id, "com.eibyx.jkanimenuvio.tvdbabsolute")
    const res = await get(`/${TOKEN}/stream/series/tt7441658:1:5.json`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get("access-control-allow-origin"), "*")
    assert.ok((await res.json()).streams.length > 0)
    const withConfig = await (await get(`/${TOKEN}/numbering=cinemeta/stream/series/tt7441658:1:5.json`)).json()
    assert.ok(withConfig.streams.length > 0)
    const extra = await (await get(`/${TOKEN}/stream/series/tt7441658:1:5/videoHash=abc.json`)).json()
    assert.ok(extra.streams.length > 0)
    // Unknown paths under the token are 404 too; /health stays free.
    assert.equal((await get(`/${TOKEN}/catalog/series/x.json`)).status, 404)
    assert.deepEqual(await (await get("/health")).json(), { ok: true })
  } finally { await close() }
})

test("a wrong, partial or longer token is rejected", async () => {
  const { get, close } = await serve({ ADDON_TOKEN: TOKEN })
  try {
    for (const t of [TOKEN.slice(0, -1), TOKEN + "x", TOKEN.toUpperCase(), "", "%20" + TOKEN]) {
      assert.equal((await get(`/${t}/manifest.json`)).status, 404, t)
    }
    // The token segment and a config segment cannot be confused.
    assert.equal((await get(`/numbering=tmdb/${TOKEN}/manifest.json`)).status, 404)
    assert.equal((await get(`/${TOKEN}/${TOKEN}/manifest.json`)).status, 200, "a second segment is just an (ignored) config")
  } finally { await close() }
})

test("the install page under the token shows the full URL; the token is never echoed elsewhere", async () => {
  const { get, close } = await serve({ ADDON_TOKEN: TOKEN })
  try {
    const page = await (await get(`/${TOKEN}/`, { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "mi-app.koyeb.app" })).text()
    assert.ok(page.includes(`https://mi-app.koyeb.app/${TOKEN}/manifest.json`))
    for (const p of ["/manifest.json", "/nope", "/%E0%A4%A/manifest.json"]) {
      assert.ok(!(await (await get(p)).text()).includes(TOKEN), p)
    }
  } finally { await close() }
})

test("ADDON_TOKEN with characters that do not fit in a URL segment refuses to start", () => {
  process.env.ADDON_TOKEN = "has/slash"
  assert.throws(() => createApp(), /ADDON_TOKEN/)
  process.env.ADDON_TOKEN = "has space"
  assert.throws(() => createApp(), /ADDON_TOKEN/)
})

test("the token never reaches the startup log", async () => {
  const child = spawn(process.execPath, ["index.js"], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: "production", PORT: String(randomPort()), HOST: "127.0.0.1", ADDON_TOKEN: TOKEN },
  })
  let out = ""
  child.stdout.on("data", (d) => { out += d })
  child.stderr.on("data", (d) => { out += d })
  await new Promise((resolve) => child.stdout.on("data", () => { if (/listening/.test(out)) resolve() }))
  child.kill("SIGTERM")
  const code = await new Promise((r) => child.on("exit", r))
  assert.equal(code, 0)
  assert.match(out, /\/\{ADDON_TOKEN\}\/manifest\.json/)
  assert.ok(!out.includes(TOKEN))
})

test("SIGTERM and SIGINT shut the server down cleanly", async () => {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const child = spawn(process.execPath, ["index.js"], { cwd: ROOT, env: { ...process.env, PORT: String(randomPort()), HOST: "127.0.0.1" } })
    let out = ""
    await new Promise((resolve) => child.stdout.on("data", (d) => { out += d; if (/listening/.test(out)) resolve() }))
    const t0 = Date.now()
    child.kill(signal)
    const code = await new Promise((r) => child.on("exit", r))
    assert.equal(code, 0, signal)
    assert.ok(Date.now() - t0 < 5000, `${signal} exit took too long`)
    assert.match(out, new RegExp(`${signal} received`))
  }
})

test("install page honours PUBLIC_URL, then X-Forwarded-Proto/Host, and escapes what it shows", async () => {
  const req = (headers, host = "127.0.0.1:3000") => ({
    protocol: "http",
    get: (n) => (n.toLowerCase() === "host" ? host : headers[n.toLowerCase()]),
  })
  assert.equal(publicBase(req({})), "http://127.0.0.1:3000")
  assert.equal(publicBase(req({ "x-forwarded-proto": "https", "x-forwarded-host": "mi-app.koyeb.app" })), "https://mi-app.koyeb.app")
  assert.equal(publicBase(req({ "x-forwarded-proto": "https, http" })), "https://127.0.0.1:3000")
  assert.equal(publicBase(req({ "x-forwarded-proto": "javascript", "x-forwarded-host": "evil\"><script>" })), "http://127.0.0.1:3000")
  process.env.PUBLIC_URL = "https://anime.example.com/"
  assert.equal(publicBase(req({ "x-forwarded-host": "other.example" })), "https://anime.example.com")

  delete process.env.PUBLIC_URL
  const { get, close } = await serve()
  try {
    const page = await (await get("/", { "X-Forwarded-Proto": "https" })).text()
    assert.match(page, /https:\/\/127\.0\.0\.1:\d+\/manifest\.json/)
  } finally { await close() }
})

test("TRUST_PROXY is parsed the way Express expects", () => {
  assert.equal(trustProxySetting(""), null)
  assert.equal(trustProxySetting("true"), true)
  assert.equal(trustProxySetting("FALSE"), false)
  assert.equal(trustProxySetting("2"), 2)
  assert.equal(trustProxySetting("loopback, uniquelocal"), "loopback, uniquelocal")
})

test("RATE_LIMIT_PER_MIN limits each IP, answers 429 with Retry-After, and never limits /health", async () => {
  const { get, close } = await serve({ RATE_LIMIT_PER_MIN: "3" })
  try {
    const codes = []
    for (let i = 0; i < 5; i++) codes.push((await get("/manifest.json")).status)
    assert.deepEqual(codes, [200, 200, 200, 429, 429])
    const blocked = await get("/manifest.json")
    assert.ok(Number(blocked.headers.get("retry-after")) >= 1)
    assert.equal(blocked.headers.get("access-control-allow-origin"), "*")
    assert.equal((await get("/health")).status, 200)
  } finally { await close() }
})

test("rate limiter: separate IPs, window reset and bounded memory", () => {
  let now = 0
  const mw = rateLimit({ perMinute: 1, maxClients: 2, now: () => now })
  const call = (ip) => {
    let status = 200
    const res = { set() {}, status(s) { status = s; return this }, json() {} }
    mw({ ip }, res, () => {})
    return status
  }
  assert.equal(call("a"), 200)
  assert.equal(call("a"), 429)
  assert.equal(call("b"), 200)
  assert.equal(call("c"), 200, "a third client evicts the oldest instead of growing")
  now = 61000
  assert.equal(call("a"), 200, "a new window starts after a minute")
})

test("malformed URLs get a JSON 400 without stack trace or paths, also in development", async () => {
  const prev = process.env.NODE_ENV
  process.env.NODE_ENV = "development"
  const { get, close } = await serve()
  try {
    const res = await get("/%E0%A4%A/manifest.json")
    assert.equal(res.status, 400)
    const text = await res.text()
    assert.deepEqual(JSON.parse(text), { error: "bad request" })
    assert.doesNotMatch(text, /node_modules|URIError|at |\/home\//)
  } finally {
    process.env.NODE_ENV = prev
    await close()
  }
})

test("/status (STATUS_ENABLED=true) is behind the token and reports state without secrets", async () => {
  setCredentials({ pin: true })
  installFakeNet()
  const { get, close } = await serve({ ADDON_TOKEN: TOKEN, STATUS_ENABLED: "true", RATE_LIMIT_PER_MIN: "100" })
  try {
    assert.equal((await get("/status")).status, 404)
    const before = await (await get(`/${TOKEN}/status`)).json()
    assert.equal(before.jkanime.last, null)
    assert.match(before.jkanime.verdict, /Sin peticiones/)
    await get(`/${TOKEN}/stream/series/tt7441658:1:5.json`)
    const res = await get(`/${TOKEN}/status`)
    assert.equal(res.headers.get("cache-control"), "no-store")
    const text = await res.text()
    const s = JSON.parse(text)
    assert.equal(s.version, require("../package.json").version)
    assert.equal(typeof s.uptimeSeconds, "number")
    assert.ok(s.memoryMB.rss > 0)
    assert.ok(s.caches.streams.size >= 1)
    assert.deepEqual(
      { tmdb: s.providers.tmdb, tvdb: s.providers.tvdb, cinemeta: s.providers.cinemeta },
      { tmdb: true, tvdb: true, cinemeta: true })
    assert.equal(s.security.token, true)
    assert.equal(s.security.rateLimitPerMin, 100)
    assert.equal(s.jkanime.last.result, "OK")
    assert.match(s.jkanime.verdict, /responde/)
    for (const secret of [TOKEN, ...Object.values(FAKE)]) assert.ok(!text.includes(secret), "secret leaked")
    assert.doesNotMatch(text, /\.m3u8|\.mp4|https?:\/\//, "no media or URLs")
  } finally { await close() }
})

test("/status reports a Cloudflare block of this server's IP", async () => {
  installFakeNet({ blocked: true })
  const { get, close } = await serve({ STATUS_ENABLED: "true" })
  try {
    await get("/stream/series/tt7441658:1:1.json")
    const s = await (await get("/status")).json()
    assert.equal(s.jkanime.last.result, "BLOCKED")
    assert.ok(s.jkanime.counts.blocked >= 1)
    assert.match(s.jkanime.verdict, /bloquea/)
  } finally { await close() }
})

test("JKAnime outcomes are classified: 404 is reachable, challenge is BLOCKED, the rest ERROR", () => {
  upstream.record(null)
  assert.equal(upstream.snapshot().last.result, "OK")
  upstream.record(new HttpError("HTTP 404", 404, "https://jkanime.net/x/9/"))
  assert.equal(upstream.snapshot().last.result, "OK")
  upstream.record(new BlockedError("https://jkanime.net/buscar/x", 403))
  assert.deepEqual([upstream.snapshot().last.result, upstream.snapshot().last.code], ["BLOCKED", "BLOCKED"])
  upstream.record(new HttpError("timed out", 0, undefined, "TIMEOUT"))
  assert.deepEqual([upstream.snapshot().last.result, upstream.snapshot().last.code], ["ERROR", "TIMEOUT"])
  const s = upstream.snapshot()
  assert.deepEqual(s.counts, { ok: 2, blocked: 1, error: 1 })
  assert.equal(s.lastBlocked.result, "BLOCKED")
  assert.ok(!JSON.stringify(s).includes("jkanime.net"), "no URLs kept")
})

test("Dockerfile and .dockerignore follow the deployment rules", () => {
  const docker = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8")
  assert.match(docker, /^FROM node:22-(alpine|slim)/m)
  assert.match(docker, /npm ci --omit=dev/)
  assert.match(docker, /^USER (node|\d+)/m)
  assert.match(docker, /NODE_ENV=production/)
  assert.match(docker, /^HEALTHCHECK [\s\S]*\/health/m)
  const ignore = fs.readFileSync(path.join(ROOT, ".dockerignore"), "utf8").split("\n").map((l) => l.trim())
  for (const entry of [".env", "node_modules", "test", "test-support", "docs", ".git"]) assert.ok(ignore.includes(entry), entry)
})
