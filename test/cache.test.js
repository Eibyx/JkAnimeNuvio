const { test, afterEach } = require("node:test")
const assert = require("node:assert/strict")
const { TTLCache, cacheStats } = require("../lib/utils/cache")

afterEach(() => { delete process.env.CACHE_MAX_ENTRIES })

test("a full cache evicts the least recently used entry, not the oldest insert", () => {
  const c = new TTLCache({ ttlMs: 60000, maxEntries: 3 })
  c.set("a", 1); c.set("b", 2); c.set("c", 3)
  assert.equal(c.get("a"), 1) // "a" is now the most recent
  c.set("d", 4)
  assert.equal(c.get("b"), undefined)
  assert.deepEqual(["a", "c", "d"].map((k) => c.get(k)), [1, 3, 4])
  assert.equal(c.size, 3)
})

test("expired entries are dropped before any live one", () => {
  const c = new TTLCache({ ttlMs: 60000, maxEntries: 3 })
  c.set("old", 1, -1); c.set("live1", 2); c.set("live2", 3)
  c.set("new", 4)
  assert.equal(c.size, 3)
  assert.deepEqual(["live1", "live2", "new"].map((k) => c.get(k)), [2, 3, 4])
})

test("re-setting a key does not grow the cache", () => {
  const c = new TTLCache({ ttlMs: 60000, maxEntries: 2 })
  c.set("a", 1); c.set("a", 2); c.set("b", 3)
  assert.equal(c.size, 2)
  assert.equal(c.get("a"), 2)
})

test("CACHE_MAX_ENTRIES lowers every cache's cap but never raises it", () => {
  process.env.CACHE_MAX_ENTRIES = "50"
  assert.equal(new TTLCache({ ttlMs: 1, maxEntries: 500 }).maxEntries, 50)
  assert.equal(new TTLCache({ ttlMs: 1, maxEntries: 10 }).maxEntries, 10)
  process.env.CACHE_MAX_ENTRIES = "nonsense"
  assert.equal(new TTLCache({ ttlMs: 1, maxEntries: 500 }).maxEntries, 500)
})

test("named caches report size and cap", () => {
  const c = new TTLCache({ ttlMs: 60000, maxEntries: 7, name: "test-cache" })
  c.set("x", 1)
  assert.deepEqual(cacheStats()["test-cache"], { size: 1, max: 7 })
  // The application caches are registered as well.
  require("../lib/app")
  for (const name of ["streams", "metadata", "mappings", "jkanimeSearch", "jkanimeAnime", "jkanimeEpisode"]) {
    assert.ok(name in cacheStats(), name)
  }
})

test("wrap keeps deduplicating concurrent lookups", async () => {
  const c = new TTLCache({ ttlMs: 60000, maxEntries: 5 })
  let runs = 0
  const fn = async () => { runs++; return "v" }
  assert.deepEqual(await Promise.all([c.wrap("k", fn), c.wrap("k", fn)]), ["v", "v"])
  assert.equal(runs, 1)
})
