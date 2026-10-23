/**
 * Starts the HTTP server and shuts it down cleanly on SIGTERM/SIGINT (Render
 * and Docker send SIGTERM on every redeploy; as PID 1 in a container, Node
 * would otherwise ignore it until the platform kills it).
 */
const { createApp } = require("./app")

const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 10000

function start({ port, host, log = console.log } = {}) {
  const app = createApp()
  const server = app.listen(port, host, () => {
    const { port: actual } = server.address()
    // The token, if any, is never printed: only a placeholder.
    const prefix = (process.env.ADDON_TOKEN || "").trim() ? "/{ADDON_TOKEN}" : ""
    log(`JKAnimeNuvio listening on http://${host}:${actual}${prefix}/manifest.json`)
  })

  let closing = false
  function shutdown(signal) {
    if (closing) return
    closing = true
    log(`[server] ${signal} received, closing (max ${SHUTDOWN_TIMEOUT_MS} ms)`)
    // Stop accepting connections, let in-flight requests finish, drop idle keep-alives.
    server.close(() => process.exit(0))
    server.closeIdleConnections?.()
    setTimeout(() => {
      log("[server] forcing exit: requests still pending")
      process.exit(0)
    }, SHUTDOWN_TIMEOUT_MS).unref()
  }
  process.once("SIGTERM", () => shutdown("SIGTERM"))
  process.once("SIGINT", () => shutdown("SIGINT"))
  return server
}

module.exports = { start }
