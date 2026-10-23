/**
 * Simple per-IP request limit (fixed one-minute window, in memory). Meant for
 * a single small instance: it protects JKAnime and the server's own IP from
 * a client that hammers the addon, it is not a defence against a botnet.
 */
const WINDOW_MS = 60 * 1000

/**
 * @param {{perMinute: number, maxClients?: number, now?: () => number}} opts
 * @returns {import("express").RequestHandler}
 */
function rateLimit({ perMinute, maxClients = 10000, now = Date.now }) {
  const clients = new Map() // ip -> { count, resetAt }
  return function rateLimitMiddleware(req, res, next) {
    const t = now()
    const ip = req.ip || req.socket?.remoteAddress || "unknown"
    let entry = clients.get(ip)
    if (!entry || entry.resetAt <= t) {
      if (!entry && clients.size >= maxClients) {
        for (const [key, e] of clients) if (e.resetAt <= t) clients.delete(key)
        // Still full: forget the oldest client rather than grow without bound.
        if (clients.size >= maxClients) clients.delete(clients.keys().next().value)
      }
      entry = { count: 0, resetAt: t + WINDOW_MS }
      clients.set(ip, entry)
    }
    entry.count++
    if (entry.count <= perMinute) return next()
    res.set("Retry-After", String(Math.max(1, Math.ceil((entry.resetAt - t) / 1000))))
    res.status(429).json({ error: "too many requests" })
  }
}

module.exports = { rateLimit }
