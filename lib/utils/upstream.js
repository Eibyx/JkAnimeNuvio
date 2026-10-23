/**
 * Outcome of the latest requests to JKAnime, for /status: shows at a glance
 * whether the site answers or Cloudflare blocks this server's IP. Only codes
 * and times are kept, never URLs.
 */
const { errorCode } = require("./errors")

const state = { last: null, lastOk: null, lastBlocked: null, lastError: null, counts: { ok: 0, blocked: 0, error: 0 } }

/** @param {Error|null} err - null for a successful request */
function record(err, now = Date.now()) {
  let entry
  // A 404 means the site answered normally (missing episode): JKAnime is reachable.
  if (!err || err.status === 404) entry = { result: "OK", at: now }
  else {
    const code = errorCode(err)
    entry = { result: code === "BLOCKED" ? "BLOCKED" : "ERROR", code, at: now }
  }
  state.last = entry
  if (entry.result === "OK") { state.lastOk = entry; state.counts.ok++ }
  else if (entry.result === "BLOCKED") { state.lastBlocked = entry; state.counts.blocked++ }
  else { state.lastError = entry; state.counts.error++ }
}

const iso = (e) => (e ? { ...e, at: new Date(e.at).toISOString() } : null)

function snapshot() {
  return {
    last: iso(state.last),
    lastOk: iso(state.lastOk),
    lastBlocked: iso(state.lastBlocked),
    lastError: iso(state.lastError),
    counts: { ...state.counts },
  }
}

function reset() {
  Object.assign(state, { last: null, lastOk: null, lastBlocked: null, lastError: null, counts: { ok: 0, blocked: 0, error: 0 } })
}

module.exports = { record, snapshot, reset }
