/**
 * Small in-memory TTL cache that also de-duplicates concurrent lookups for
 * the same key. Rejected promises are never cached.
 */
class TTLCache {
  constructor({ ttlMs, maxEntries = 500 }) {
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
    this.map = new Map()
  }

  get(key) {
    const hit = this.map.get(key)
    if (!hit) return undefined
    if (hit.expires < Date.now()) {
      this.map.delete(key)
      return undefined
    }
    return hit.value
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (!this.map.has(key) && this.map.size >= this.maxEntries) this.map.delete(this.map.keys().next().value)
    this.map.set(key, { value, expires: Date.now() + ttlMs })
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

module.exports = { TTLCache }
