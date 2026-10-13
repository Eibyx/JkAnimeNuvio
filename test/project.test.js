/**
 * Regression tests for the repository cleanup: JKAnimeNuvio must stay a
 * stream-only, JKAnime-only, self-hosted addon.
 */
const { test, before, after } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { resetAll } = require("../test-support/helpers")
const { createApp } = require("../lib/app")

const ROOT = path.join(__dirname, "..")
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8")
const exists = (f) => fs.existsSync(path.join(ROOT, f))
const libFiles = (dir = "lib") => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? libFiles(path.join(dir, e.name)) : e.name.endsWith(".js") ? [path.join(dir, e.name)] : []))

let server
let base
before(async () => {
  server = createApp().listen(0, "127.0.0.1")
  await new Promise((r) => server.once("listening", r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => { server.close(); resetAll() })

test("legacy files of the original project are gone", () => {
  for (const f of ["routes", "views", "public", "vercel.json", ".github/workflows/deploy.yml", ".github/FUNDING.yml",
    "lib/streamParsing.js", "lib/metadata.js", "routes/metadata_copy.js", "routes/relations.js"]) {
    assert.equal(exists(f), false, `${f} should not exist`)
  }
  assert.ok(exists(".github/workflows/ci.yml"), "CI must stay")
  assert.ok(exists("LICENSE"))
})

test("no old anime providers or original hosting in the code", () => {
  const legacy = /\b(animeav1|henaojara|tioanime|animejara|AnimES)\b|animeflv(?!-api|-stremio-addon)|alwaysdata|pigamer37\.alwaysdata/i
  for (const f of [...libFiles(), "index.js", "scripts/live-check.js", "package.json", ".env.example"]) {
    assert.doesNotMatch(read(f), legacy, f)
  }
})

test("dependencies are exactly what the addon uses", () => {
  const pkg = JSON.parse(read("package.json"))
  assert.equal(pkg.name, "jkanimenuvio")
  assert.equal(pkg.version, "0.2.1")
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["cheerio", "dotenv", "express", "unpacker"])
  assert.equal(pkg.devDependencies, undefined)
  // Every dependency is really required somewhere.
  const code = [...libFiles(), "index.js"].map(read).join("\n")
  for (const dep of Object.keys(pkg.dependencies)) assert.match(code, new RegExp(`require\\("${dep}"\\)`), dep)
})

test("attribution and license notices are kept", () => {
  assert.match(read("LICENSE"), /Copyright \(c\) 2024 Lucas Gómez \(KB\)/)
  assert.match(read("README.md"), /github\.com\/Pigamer37\/animeflv-stremio-addon/)
  assert.match(read("lib/jkanime/extractors.js"), /mediaflow-proxy/)
})

test("private configuration is not tracked and .env.example has no values for credentials", () => {
  const ignore = read(".gitignore").split("\n").map((l) => l.trim())
  assert.ok(ignore.includes(".env") && ignore.includes("!.env.example"))
  const example = read(".env.example")
  for (const v of ["TMDB_API_READ_TOKEN", "TMDB_API_KEY", "TVDB_API_KEY", "TVDB_SUBSCRIBER_PIN"]) {
    assert.match(example, new RegExp(`^${v}=$`, "m"), `${v} must be empty`)
  }
})

test("only the stream resource is published; legacy routes return 404", async () => {
  const m = await (await fetch(`${base}/manifest.json`)).json()
  assert.deepEqual(m.resources.map((r) => r.name), ["stream"])
  assert.deepEqual(m.catalogs, [])
  assert.equal(m.name, "JKAnimeNuvio")
  assert.match(m.id, /^com\.eibyx\.jkanimenuvio/)
  for (const p of ["/configure", "/numbering=tmdb/configure", "/catalog/JKAnime/jkanime.json",
    "/catalog/anime/jkanime%7Cgenres/genre=accion.json", "/meta/series/jkanime:black-clover-tv.json",
    "/meta/anime/tt7441658.json", "/numbering=tmdb/catalog/series/x.json", "/AnimES.png"]) {
    assert.equal((await fetch(base + p)).status, 404, p)
  }
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true })
})
