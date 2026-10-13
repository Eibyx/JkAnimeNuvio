/**
 * JKAnime scraping against REAL pages archived on web.archive.org (2026-06..10,
 * test/fixtures/jkanime/, CSRF tokens replaced). The session/419 test uses a
 * SIMULATED server: it shows what the addon sends, not how JKAnime answers.
 */
const { test, beforeEach, afterEach } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { resetAll, response } = require("../test-support/helpers")
const http = require("../lib/utils/http")
const site = require("../lib/jkanime/site")

beforeEach(resetAll)
afterEach(resetAll)

const page = (name) => fs.readFileSync(path.join(__dirname, "fixtures", "jkanime", name), "utf8")
const withCookies = (body, cookies, extra = {}) => {
  const headers = new Headers()
  for (const c of cookies) headers.append("set-cookie", c)
  return { ...response(body, extra), headers }
}

test("real search page: results with title, slug and type", () => {
  assert.deepEqual(site.parseSearch(page("search-black-clover.html")), [
    { title: "Black Clover (TV)", slug: "black-clover-tv", type: "Serie" },
    { title: "Black Clover: Mahou Tei no Ken", slug: "black-clover-mahou-tei-no-ken", type: "Pelicula" },
  ])
})

test("a valid search page without results is [], an unknown page is PARSER_CHANGED", () => {
  const html = page("search-black-clover.html")
  const empty = html.replace(/<div class="anime__item">[\s\S]*?<\/h5>/g, "")
  assert.deepEqual(site.parseSearch(empty), [])
  assert.throws(() => site.parseSearch("<html><body><h1>Sitio en mantenimiento</h1></body></html>"), { code: "PARSER_CHANGED" })
})

test("real anime pages: year, episodes, status and alternative title", () => {
  const bc = site.parseAnimePage(page("anime-black-clover-tv.html"), "black-clover-tv")
  assert.deepEqual([bc.title, bc.altTitle, bc.type, bc.year, bc.episodes, bc.status], ["Black Clover (TV)", "Black Clover", "Serie", 2017, 170, "finished"])
  const koori = site.parseAnimePage(page("anime-koori-no-jouheki.html"), "koori-no-jouheki")
  assert.deepEqual([koori.title, koori.altTitle, koori.year, koori.episodes, koori.status], ["Koori no Jouheki", "The Ramparts of Ice", 2026, 14, "airing"])
  // Before its premiere the Ao Ashi S2 page had no air date and "Episodios: 0".
  const ao = site.parseAnimePage(page("anime-ao-ashi-season-2-upcoming.html"), "ao-ashi-season-2")
  assert.deepEqual([ao.title, ao.altTitle, ao.year, ao.episodes, ao.status], ["Ao Ashi Season 2", "Aoashi Season 2", null, null, "upcoming"])
  assert.throws(() => site.parseAnimePage("<html><body><h3>Algo</h3></body></html>", "x"), { code: "PARSER_CHANGED" })
})

test("real episode page: number, own players and the server list", () => {
  const ep = site.parseEpisodePage(page("episode-gensou-suikoden-1.html"))
  assert.equal(ep.number, 1)
  assert.equal(ep.players.length, 2)
  assert.deepEqual(ep.servers.map((s) => s.name), ["Mediafire", "Mega", "VOE", "Vidhide", "Filemoon", "Mixdrop", "Streamtape", "Streamwish", "Doodstream", "1Fichier"])
})

test("search cache: hits 1 h, empty results 10 min, unreadable pages are not cached", async () => {
  let calls = 0
  let body = page("search-black-clover.html")
  http.setFetch(async () => { calls++; return response(body) })
  await site.search("black clover")
  const hit = site.caches[0].map.get("black clover")
  assert.ok(hit.expires - Date.now() > 50 * 60 * 1000)

  body = body.replace(/<div class="anime__item">[\s\S]*?<\/h5>/g, "")
  assert.deepEqual(await site.search("nada"), [])
  const empty = site.caches[0].map.get("nada")
  assert.ok(empty.expires - Date.now() <= 10 * 60 * 1000)

  body = "<html><body>Error</body></html>"
  calls = 0
  await assert.rejects(site.search("roto"), { code: "PARSER_CHANGED" })
  await assert.rejects(site.search("roto"), { code: "PARSER_CHANGED" })
  assert.equal(calls, 2, "a parse failure is retried, not remembered as 'no results'")
})

test("anime cache: airing pages expire after 30 min, finished ones after 6 h", async () => {
  http.setFetch(async (href) => response(page(href.includes("koori") ? "anime-koori-no-jouheki.html" : "anime-black-clover-tv.html"), { url: href }))
  await site.getAnime("koori-no-jouheki")
  await site.getAnime("black-clover-tv")
  const ttl = (slug) => site.caches[1].map.get(slug).expires - Date.now()
  assert.ok(ttl("koori-no-jouheki") <= 30 * 60 * 1000)
  assert.ok(ttl("black-clover-tv") > 5 * 60 * 60 * 1000)
})

test("SIMULATED: the episode-count request carries the page's session cookie (HTTP 419 fix)", async () => {
  const sent = []
  const html = page("anime-black-clover-tv.html").replace(/<li><span>Episodios:<\/span> 170<\/li>/g, "")
  http.setFetch(async (href, opts) => {
    sent.push({ href, cookie: opts.headers.Cookie, body: opts.body })
    if (href.includes("/ajax/episodes/")) {
      // Laravel answers 419 when the CSRF token comes without its session.
      return /jkanime_session=abc/.test(opts.headers.Cookie || "") ? response({ total: 170 }) : response("", { status: 419 })
    }
    return withCookies(html, ["XSRF-TOKEN=xyz; expires=Wed, 14 Oct 2026 01:00:00 GMT; path=/; samesite=lax", "jkanime_session=abc; path=/; httponly"], { url: href })
  })
  const info = await site.getAnime("black-clover-tv")
  assert.equal(info.episodes, 170)
  const ajax = sent.find((s) => s.href.includes("/ajax/episodes/2121/1"))
  assert.equal(ajax.cookie, "XSRF-TOKEN=xyz; jkanime_session=abc")
  assert.equal(ajax.body, "_token=archived-token")
  assert.equal("csrf" in info, false)
})

test("without the episode count the anime is still usable (419 is not fatal)", async () => {
  const html = page("anime-black-clover-tv.html").replace(/<li><span>Episodios:<\/span> 170<\/li>/g, "")
  http.setFetch(async (href) => (href.includes("/ajax/") ? response("", { status: 419 }) : response(html, { url: href })))
  const info = await site.getAnime("black-clover-tv")
  assert.deepEqual([info.year, info.episodes], [2017, null])
})

test("episodes: redirect to the anime page or 404 = EPISODE_NOT_FOUND", async () => {
  http.setFetch(async (href) => {
    if (href.endsWith("/99/")) return response(page("anime-black-clover-tv.html"), { url: "https://jkanime.net/black-clover-tv/" })
    if (href.endsWith("/98/")) return response("not found", { status: 404, url: href })
    return response(page("episode-gensou-suikoden-1.html"), { url: href })
  })
  await assert.rejects(site.getEpisode("black-clover-tv", 99), { code: "EPISODE_NOT_FOUND" })
  await assert.rejects(site.getEpisode("black-clover-tv", 98), { code: "EPISODE_NOT_FOUND" })
  await assert.rejects(site.getEpisode("gensou-suikoden", 2), { code: "EPISODE_NOT_FOUND" }, "page says episode 1")
  assert.equal((await site.getEpisode("gensou-suikoden", 1)).servers.length, 10)
})
