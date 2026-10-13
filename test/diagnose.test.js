/**
 * Diagnostic mode (scripts/diagnose.js) on the offline fake network.
 */
const { test, beforeEach, afterEach } = require("node:test")
const assert = require("node:assert/strict")
const { installFakeNet, resetAll, DEFAULT_ANIME, setCredentials, FAKE } = require("../test-support/helpers")
const { diagnose } = require("../scripts/diagnose")

beforeEach(resetAll)
afterEach(resetAll)

test("kitsu:49883:1: identity, queries, candidates, match, servers and SUCCESS", async () => {
  installFakeNet()
  const { status, lines, report } = await diagnose("kitsu:49883:1")
  const text = lines.join("\n")
  assert.equal(status, "SUCCESS")
  for (const tag of ["[REQUEST]", "[IDENTITY] OK", "[SEARCH]", "[CANDIDATE] OK", "[MATCH] ao-ashi-season-2 episode 1", "[EPISODE] OK", "[SERVER]", "[TIME]", "[STATUS] SUCCESS"]) {
    assert.ok(text.includes(tag), `${tag}\n${text}`)
  }
  assert.ok(report.requests.total > 0)
  // Media links appear only as host + format.
  assert.doesNotMatch(text, /https?:\/\//)
  assert.doesNotMatch(JSON.stringify(report), /https?:\/\//)
})

test("statuses: ANIME_NOT_FOUND, EPISODE_NOT_FOUND, BLOCKED, PARSER_CHANGED", async () => {
  const anime = { ...DEFAULT_ANIME }
  delete anime["ao-ashi-season-2"]
  installFakeNet({ anime })
  let r = await diagnose("kitsu:49883:1")
  assert.equal(r.status, "ANIME_NOT_FOUND")
  assert.ok(r.lines.some((l) => l.startsWith("[SEARCH] NO_MATCH")))
  assert.ok(r.lines.some((l) => /\[CANDIDATE\] NO\s+ao-ashi "Ao Ashi"/.test(l)), "the season-1 entry is shown as rejected")

  resetAll()
  installFakeNet()
  r = await diagnose("kitsu:49883:3")
  assert.equal(r.status, "EPISODE_NOT_FOUND")

  resetAll()
  installFakeNet({ blocked: true })
  assert.equal((await diagnose("tt7441658:1:1")).status, "BLOCKED")

  resetAll()
  installFakeNet({ searchPage: () => "<html><body>Mantenimiento</body></html>" })
  assert.equal((await diagnose("kitsu:49883:1")).status, "PARSER_CHANGED")
})

test("one failing server is PARTIAL, not a failed episode; credentials are never printed", async () => {
  setCredentials({ tmdb: true, tvdb: true })
  installFakeNet({ intercept: (href) => href.includes("mp4upload") && { ok: false, status: 404, url: href, headers: new Headers(), text: async () => "gone" } })
  const { status, lines, report } = await diagnose("tt7441658:1:1")
  const text = lines.join("\n") + JSON.stringify(report)
  assert.equal(status, "SUCCESS")
  assert.ok(lines.some((l) => l.startsWith("[STREAMS] PARTIAL")))
  assert.ok(lines.some((l) => /\[SERVER\] FAIL Mp4upload .*HTTP_404/.test(l)))
  for (const secret of Object.values(FAKE)) assert.ok(!text.includes(secret), "credential leaked")
  assert.ok(text.includes("TMDB configured"))
})
