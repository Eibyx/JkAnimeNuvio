#!/usr/bin/env node
/**
 * Identification benchmark: runs the case list (test-support/eval-cases.js)
 * on the offline fake network against this checkout and, optionally, an
 * older one, and compares correct answers, missed ones, false positives,
 * season confusions, time and number of requests.
 *
 *   node scripts/evaluate.js                      # this checkout only
 *   git worktree add ../jk-old main && (cd ../jk-old && npm ci)
 *   node scripts/evaluate.js --old ../jk-old      # old vs new
 *   node scripts/evaluate.js --old ../jk-old --json
 *
 * Simulated network: these numbers measure the identification logic, not
 * JKAnime itself.
 */
const path = require("node:path")
const helpers = require("../test-support/helpers")
const CASES = require("../test-support/eval-cases")

function libAt(root) {
  const r = (p) => require(path.join(root, p))
  return {
    root,
    http: r("lib/utils/http"),
    resolver: r("lib/identification/resolver"),
    common: r("lib/providers/common"),
    tvdb: r("lib/providers/tvdb"),
    site: r("lib/jkanime/site"),
  }
}

function reset(lib) {
  lib.http.resetFetch()
  lib.common.cache.clear()
  lib.common.mappingCache.clear()
  lib.tvdb.resetSession()
  lib.site.caches.forEach((c) => c.clear())
  helpers.clearCredentials()
}

async function runCase(lib, c) {
  reset(lib)
  const calls = []
  helpers.installFakeNet({ ...(c.net || {}), calls }, lib.http)
  if (c.entry) lib.common.cache.set(c.entry.key, Promise.resolve(c.entry.value))
  const t0 = process.hrtime.bigint()
  let got = null
  let error = null
  try {
    const r = await lib.resolver.resolve(c.type || "series", c.id, c.config || {})
    got = `${r.slug}#${r.episode}`
  } catch (err) {
    error = err.code || err.name
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  let outcome
  if (got === c.expect) outcome = "correct"
  else if (!got && !c.expect) outcome = "correct-empty"
  else if (!got) outcome = "missed"
  else if (c.family && got.startsWith(c.family)) outcome = "season-confusion"
  else outcome = "false-positive"
  return {
    name: c.name, id: c.id, expect: c.expect, got, error, outcome, ms: +ms.toFixed(1),
    requests: calls.length, jkRequests: calls.filter((u) => u.includes("jkanime.net")).length,
    jkSearches: calls.filter((u) => u.includes("jkanime.net/buscar/")).length,
  }
}

function summary(rows) {
  const count = (o) => rows.filter((r) => r.outcome === o).length
  return {
    cases: rows.length,
    correct: count("correct") + count("correct-empty"),
    missed: count("missed"),
    falsePositives: count("false-positive") + count("season-confusion"),
    seasonConfusions: count("season-confusion"),
    totalMs: +rows.reduce((a, r) => a + r.ms, 0).toFixed(1),
    requests: rows.reduce((a, r) => a + r.requests, 0),
    jkRequests: rows.reduce((a, r) => a + r.jkRequests, 0),
    jkSearches: rows.reduce((a, r) => a + r.jkSearches, 0),
  }
}

async function evaluate(roots) {
  const out = {}
  for (const [label, root] of Object.entries(roots)) {
    const lib = libAt(root)
    const rows = []
    for (const c of CASES) rows.push(await runCase(lib, c))
    reset(lib)
    out[label] = { rows, summary: summary(rows) }
  }
  return out
}
exports.evaluate = evaluate

if (require.main === module) {
  const args = process.argv.slice(2)
  const oldIdx = args.indexOf("--old")
  const roots = {}
  if (oldIdx !== -1) roots.old = path.resolve(args[oldIdx + 1])
  roots.new = path.resolve(__dirname, "..")
  evaluate(roots).then((res) => {
    if (args.includes("--json")) return console.log(JSON.stringify(res, null, 2))
    const labels = Object.keys(res)
    const mark = { correct: "OK", "correct-empty": "OK (vacío)", missed: "SIN RESULTADO", "false-positive": "FALSO POSITIVO", "season-confusion": "MISMA SERIE, ENTRADA O EPISODIO EQUIVOCADO" }
    console.log(`| Caso | Esperado | ${labels.map((l) => `${l}`).join(" | ")} |`)
    console.log(`|---|---|${labels.map(() => "---").join("|")}|`)
    CASES.forEach((c, i) => {
      console.log(`| ${c.name} (\`${c.id}\`) | ${c.expect || "ninguno"} | ${labels.map((l) => {
        const r = res[l].rows[i]
        return `${mark[r.outcome]}${r.got && r.outcome !== "correct" ? ` → ${r.got}` : ""}`
      }).join(" | ")} |`)
    })
    console.log("")
    console.log(`| Métrica | ${labels.join(" | ")} |`)
    console.log(`|---|${labels.map(() => "---").join("|")}|`)
    for (const [k, name] of [["correct", "Correctos"], ["missed", "Sin resultado (esperado uno)"], ["falsePositives", "Falsos positivos"], ["seasonConfusions", "…de ellos, misma serie con entrada/episodio equivocado"], ["jkSearches", "Búsquedas en JKAnime"], ["jkRequests", "Peticiones a JKAnime"], ["requests", "Peticiones totales"], ["totalMs", "Tiempo total (ms, red simulada)"]]) {
      console.log(`| ${name} | ${labels.map((l) => res[l].summary[k]).join(" | ")} |`)
    }
  }, (err) => { console.error(err); process.exitCode = 1 })
}
