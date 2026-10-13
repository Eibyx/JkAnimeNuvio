#!/usr/bin/env node
/**
 * Explains, step by step, what the addon does for one Stremio id:
 *
 *   npm run diagnose -- kitsu:50761:1
 *   npm run diagnose -- tt7441658:2:1 --numbering tvdb
 *   npm run diagnose -- tt0000002 --type movie --json
 *
 * Prints identification sources, JKAnime queries and their result counts,
 * every candidate with the reason it was accepted or rejected, the chosen
 * entry and episode, each server with its links or error code, and the time
 * spent per stage. API keys are never printed, and media links only as
 * host + format (signed URLs stay private).
 */
require("dotenv").config({ quiet: true })
const { withContext, newTrace } = require("../lib/utils/context")

const STATUS = {
  SUCCESS: "streams found",
  NO_STREAMS: "episode found, but no server gave a direct link",
  ANIME_NOT_FOUND: "no JKAnime entry verified for this anime",
  AMBIGUOUS: "several JKAnime entries match equally; nothing is served",
  EPISODE_NOT_FOUND: "the anime was found, but not this episode",
  BLOCKED: "JKAnime answered with an anti-bot challenge (Cloudflare)",
  PARSER_CHANGED: "a JKAnime page no longer has the expected structure",
  IDENTITY_FAILED: "no metadata provider recognises this id",
  UNSUPPORTED_ID: "this id or season is not supported",
  NUMBERING_UNAVAILABLE: "the requested season numbering is unavailable",
  TIMEOUT: "a step took too long",
  ERROR: "unexpected error",
}

function parseArgs(argv) {
  const out = { id: null, type: null, config: {}, json: false, verbose: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--json") out.json = true
    else if (a === "--verbose") out.verbose = true
    else if (a === "--type") out.type = argv[++i]
    else if (a === "--numbering") out.config.numbering = argv[++i]
    else if (a === "--mapping") out.config.mapping = argv[++i]
    else if (!out.id) out.id = a
  }
  if (!out.type && out.id) out.type = /^(tt\d+|tmdb:\d+)$/.test(out.id) ? "movie" : "series"
  return out
}

/** host + format only: a signed link is never printed. */
const safeMedia = (url) => { try { return new URL(url).hostname } catch { return "?" } }

const credentialState = () => ({
  TMDB: process.env.TMDB_API_READ_TOKEN || process.env.TMDB_API_KEY ? "configured" : "not set",
  TVDB: process.env.TVDB_API_KEY ? "configured" : "not set",
})

/**
 * @returns {Promise<{status: string, lines: string[], report: object}>}
 */
async function diagnose(id, { type = "series", config = {} } = {}) {
  const { resolve } = require("../lib/identification/resolver")
  const { getStreams } = require("../lib/stremio/streams")
  const { errorCode } = require("../lib/utils/errors")
  const trace = newTrace()
  const lines = []
  const say = (tag, text) => lines.push(`[${tag}] ${text}`)
  const timings = {}
  const report = { id, type, config, credentials: credentialState() }
  let status = "ERROR"

  say("REQUEST", `${type} ${id} numbering=${config.numbering || "auto"} mapping=${config.mapping || "auto"} | TMDB ${report.credentials.TMDB}, TVDB ${report.credentials.TVDB}`)

  await withContext({ trace }, async () => {
    let target = null
    let t0 = Date.now()
    try {
      target = await resolve(type, id, config)
    } catch (err) {
      report.resolveError = { code: err.code || err.name, message: err.message }
      status = { BlockedError: "BLOCKED" }[err.name] || (STATUS[err.code] ? err.code : err.code === "TIMEOUT" ? "TIMEOUT" : "ERROR")
    }
    timings.identification = Date.now() - t0

    for (const e of trace.events) {
      if (e.stage === "identity") {
        say("IDENTITY", `OK ${JSON.stringify(e.name)} (${e.year ?? "year unknown"})${e.format ? ` ${e.format}` : ""}${e.episodes ? `, ${e.episodes} episodes` : ""} via ${(e.sources || []).join("+")}`)
        say("TITLES", [...(e.names || []), ...(e.aliases || [])].slice(0, 12).map((t) => JSON.stringify(t)).join(", ") || "-")
        if (e.evidence?.length) say("EVIDENCE", e.evidence.join(" | "))
      } else if (e.stage === "link") {
        say("LINK", `${e.from} -> ${e.to} (${e.via.join("+")}): ${e.level.toUpperCase()} ${e.why}`)
      } else if (e.stage === "layout") {
        say("LAYOUT", `numbering=${e.numbering} season=${e.season} episode=${e.episode} seasonYear=${e.seasonYear ?? "unknown"}`)
      } else if (e.stage === "search") {
        say("SEARCH", `${e.step.padEnd(12)} ${JSON.stringify(e.query)} -> ${e.error ? `ERROR ${e.error}` : `${e.results} results`}`)
      } else if (e.stage === "search-limit") {
        say("SEARCH", `stopped before stage ${e.step} (${e.reason}); ${e.skipped} queries not sent`)
      } else if (e.stage === "candidate") {
        say("CANDIDATE", `${e.verdict === "verified" ? "OK  " : "NO  "} ${e.slug} ${JSON.stringify(e.title)} score=${e.score}${e.match ? ` ${e.match}` : ""}${e.reason ? ` — ${e.reason}` : ""}`)
      }
    }
    if (!trace.events.some((e) => e.stage === "search") && !report.resolveError) say("SEARCH", "no JKAnime search needed")
    if (!target) {
      if (!trace.events.some((e) => e.stage === "identity")) say("IDENTITY", `FAILED ${report.resolveError?.message || ""}`)
      say("SEARCH", `${status === "AMBIGUOUS" ? "AMBIGUOUS" : status === "BLOCKED" ? "BLOCKED" : "NO_MATCH"} ${report.resolveError?.message || ""}`)
      return
    }
    report.target = target
    say("MATCH", `${target.slug} episode ${target.episode} (${target.via}, evidence ${target.evidence || "n/a"})`)

    t0 = Date.now()
    const before = trace.events.length
    let list = []
    try {
      list = await getStreams(target)
    } catch (err) {
      const code = err.name === "BlockedError" ? "BLOCKED" : errorCode(err)
      report.episodeError = { code, message: err.message }
      say("EPISODE", `${code} ${err.message}`)
      status = code === "EPISODE_NOT_FOUND" || code === "BLOCKED" || code === "PARSER_CHANGED" ? code : "ERROR"
      timings.streams = Date.now() - t0
      return
    }
    timings.streams = Date.now() - t0
    say("EPISODE", `OK ${target.slug}/${target.episode}`)
    const servers = trace.events.slice(before).filter((e) => e.stage === "server")
    const listed = trace.events.slice(before).find((e) => e.stage === "servers")
    if (listed) say("SERVERS", `${listed.listed} listed, ${listed.supported} with an extractor`)
    for (const s of servers) {
      say("SERVER", `${s.code ? "FAIL" : "OK  "} ${s.name} ${s.lang === 1 ? "SUB" : "DUB"}: ${s.code ? s.code : `${s.links} link(s) ${[...new Set(s.kinds)].join("/")}`} (${s.ms} ms)`)
    }
    for (const p of trace.events.slice(before).filter((e) => e.stage === "probe")) say("PROBE", `${p.ok ? "OK  " : "FAIL"} ${p.server} ${p.kind}${p.code ? ` ${p.code}` : ""}`)
    report.streams = list.map((s) => ({ server: s.name.split("\n")[1], host: safeMedia(s.url), format: /HLS/.test(s.description) ? "HLS" : "MP4" }))
    for (const s of report.streams) say("LINK", `${s.server} · ${s.format} · ${s.host}`)
    const failed = servers.filter((s) => s.code).length
    status = list.length ? "SUCCESS" : "NO_STREAMS"
    if (list.length && failed) say("STREAMS", `PARTIAL ${list.length} links; ${failed} of ${servers.length} servers failed (the episode itself is fine)`)
    if (!list.length && servers.length) say("STREAMS", `ALL ${servers.length} servers failed: ${servers.map((s) => s.code).join(", ")}`)
  })

  report.status = status
  report.timings = timings
  report.requests = { total: trace.requests, byHost: trace.hosts }
  say("TIME", `identification ${timings.identification ?? 0} ms, streams ${timings.streams ?? 0} ms, ${trace.requests} HTTP requests (${Object.entries(trace.hosts).map(([h, n]) => `${h}: ${n}`).join(", ")})`)
  say("STATUS", `${status} — ${STATUS[status] || ""}`)
  return { status, lines, report }
}
exports.diagnose = diagnose

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2))
  if (!args.id) {
    console.error("Uso: npm run diagnose -- <id> [--type series|movie] [--numbering auto|cinemeta|tmdb|tvdb] [--mapping auto|season|absolute] [--json] [--verbose]")
    console.error("Ejemplos: kitsu:50761:1 · tt7441658:2:1 · anilist:191788:1")
    process.exit(64)
  }
  // The modules' own log lines are noise here; --verbose shows them.
  const original = { log: console.log, warn: console.warn }
  const captured = []
  if (!args.verbose) { console.log = (...a) => captured.push(a.join(" ")); console.warn = console.log }
  diagnose(args.id, args).then(({ status, lines, report }) => {
    Object.assign(console, original)
    if (args.json) console.log(JSON.stringify(report, null, 2))
    else console.log(lines.join("\n"))
    process.exitCode = status === "SUCCESS" ? 0 : 2
  }, (err) => {
    Object.assign(console, original)
    console.error(`[STATUS] ERROR ${err.message}`)
    process.exitCode = 1
  })
}
