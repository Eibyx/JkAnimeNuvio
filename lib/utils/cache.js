/**
 * Small in-memory TTL cache that also de-duplicates concurrent lookups for
 * the same key. Rejected promises are never cached.
 *
 * Bounded: when full, expired entries go first, then the least recently used
 * one. CACHE_MAX_ENTRIES (optional) lowers the cap of every cache, for hosts
 * with little memory; it never raises a cache above its own default.
 */
const registry = []

function capFor(maxEntries) {
  const limit = Number(process.env.CACHE_MAX_ENTRIES)
  return Number.isInteger(limit) && limit > 0 ? Math.min(maxEntries, limit) : maxEntries
}

class TTLCache {
  constructor({ ttlMs, maxEntries = 500, name } = {}) {
    this.ttlMs = ttlMs
    this.maxEntries = capFor(maxEntries)
    this.name = name
    this.map = new Map()
    if (name) registry.push(this)
  }

  get size() { return this.map.size }

  get(key) {
    const hit = this.map.get(key)
    if (!hit) return undefined
    if (hit.expires < Date.now()) {
      this.map.delete(key)
      return undefined
    }
    // Map keeps insertion order: re-inserting makes this the most recent.
    this.map.delete(key)
    this.map.set(key, hit)
    return hit.value
  }

  set(key, value, ttlMs = this.ttlMs) {
    this.map.delete(key)
    if (this.map.size >= this.maxEntries) this.evict()
    this.map.set(key, { value, expires: Date.now() + ttlMs })
  }

  /** Drops expired entries; if none was expired, the least recently used one. */
  evict() {
    const now = Date.now()
    for (const [key, hit] of this.map) if (hit.expires < now) this.map.delete(key)
    if (this.map.size >= this.maxEntries) this.map.delete(this.map.keys().next().value)
  }

  /**
   * Returns the cached promise for key, or runs fn() and caches its promise.
   * @param {number|((value) => number)} ttl - a function decides from the
   *        resolved value (e.g. empty results expire sooner); 0 = do not keep
   */
  wrap(key, fn, ttl = this.ttlMs) {
    const hit = this.get(key)
    if (hit !== undefined) return hit
    const promise = Promise.resolve().then(fn)
    // While pending, a concurrent caller shares the same promise.
    this.set(key, promise, typeof ttl === "function" ? this.ttlMs : ttl)
    const mine = () => this.map.get(key)?.value === promise
    promise.then((value) => {
      if (typeof ttl !== "function" || !mine()) return
      const ms = ttl(value)
      if (ms > 0) this.set(key, promise, ms)
      else this.map.delete(key)
    }, () => { if (mine()) this.map.delete(key) })
    return promise
  }

  clear() { this.map.clear() }
}

/** Size and cap of every named cache (for /status). */
const cacheStats = () => Object.fromEntries(registry.map((c) => [c.name, { size: c.size, max: c.maxEntries }]))

module.exports = { TTLCache, cacheStats }
