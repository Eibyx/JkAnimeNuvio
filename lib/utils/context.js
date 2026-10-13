/**
 * Per-request context carried through async calls without threading
 * arguments: a cancellation signal (so a timed-out extractor stops its
 * pending requests) and an optional diagnostic trace (`npm run diagnose`).
 */
const { AsyncLocalStorage } = require("node:async_hooks")

const storage = new AsyncLocalStorage()

/** Runs fn with extra context merged over the current one. */
function withContext(extra, fn) {
  return storage.run({ ...(storage.getStore() || {}), ...extra }, fn)
}

const current = () => storage.getStore() || {}

/** Records a diagnostic event when a trace is active (no-op otherwise). */
function trace(stage, data = {}) {
  const t = current().trace
  if (t) t.events.push({ stage, at: Date.now(), ...data })
}

/** Counts an outgoing request for the active trace. */
function countRequest(host) {
  const t = current().trace
  if (!t) return
  t.requests++
  t.hosts[host] = (t.hosts[host] || 0) + 1
}

/** A fresh trace object for withContext({ trace }). */
const newTrace = () => ({ events: [], requests: 0, hosts: {} })

module.exports = { withContext, current, trace, countRequest, newTrace }
