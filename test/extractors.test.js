const { test, beforeEach, afterEach } = require("node:test")
const assert = require("node:assert/strict")
const { installFakeNet, resetAll, packed, response, b64, JK } = require("../test-support/helpers")
const http = require("../lib/utils/http")
const ex = require("../lib/jkanime/extractors")
const jkanime = require("../lib/jkanime/site")

beforeEach(resetAll)
afterEach(resetAll)

test("mediaKind only accepts direct MP4/HLS", () => {
  assert.equal(ex.mediaKind("https://cdn.example.net/hls/abc/master.m3u8"), "hls")
  assert.equal(ex.mediaKind("https://cdn.example.net/v/abc.mp4?token=1"), "mp4")
  assert.equal(ex.mediaKind("https://pixeldrain.com/api/file/abc123"), "mp4")
  assert.equal(ex.mediaKind("https://streamwish.to/e/abc"), null)
  assert.equal(ex.mediaKind("https://cdn.example.net/player.html"), null)
  assert.equal(ex.mediaKind("https://cdn.example.net/app.js?x.mp4"), null)
  assert.equal(ex.mediaKind("https://www.youtube.com/watch?v=abc"), null)
  assert.equal(ex.mediaKind("http://127.0.0.1/video.mp4"), null)
  assert.equal(ex.mediaKind("http://192.168.1.10/video.m3u8"), null)
  assert.equal(ex.mediaKind("file:///etc/passwd.mp4"), null)
  assert.equal(ex.mediaKind("https://test-videos.co.uk/bigbuckbunny.mp4"), null)
})

test("safeUrl blocks internal targets", () => {
  for (const u of ["http://localhost/x", "http://10.0.0.1/x", "http://[::1]/x", "http://169.254.169.254/latest", "http://user:pw@example.com/", "ftp://example.com/x", "http://foo.internal/x"]) {
    assert.equal(http.safeUrl(u), null, u)
  }
  assert.ok(http.safeUrl("https://jkanime.net/black-clover-tv/1/"))
})

test("unpackScripts reads P.A.C.K.E.R. without evaluating it", () => {
  const html = `<script>${packed('0({1:"2"})', ["jwplayer", "file", "https://cdn.example.net/hls/x/master.m3u8"])}</script>`
  const [unpacked] = ex.unpackScripts(html)
  assert.match(unpacked, /jwplayer\(\{file:"https:\/\/cdn\.example\.net\/hls\/x\/master\.m3u8"\}\)/)
})

test("pickExtractor matches by host, then by JKAnime server name", () => {
  assert.equal(ex.pickExtractor("https://streamwish.to/e/abc").key, "streamwish")
  assert.equal(ex.pickExtractor("https://movearnpre.com/v/abc").key, "vidhide")
  assert.equal(ex.pickExtractor("https://some-voe-mirror.com/e/abc", "VOE").key, "voe")
  assert.equal(ex.pickExtractor("https://jkanime.net/jkplayer/um?e=x").key, "jkanime")
  assert.equal(ex.pickExtractor("https://mega.nz/embed/abc", "Mega"), null)
  assert.equal(ex.pickExtractor("http://127.0.0.1/e/abc", "Streamwish"), null)
})

test("extractors return direct URLs with Referer headers", async () => {
  installFakeNet()
  const yu = await ex.extract("https://www.yourupload.com/embed/abc", "YourUpload")
  assert.deepEqual(yu.map((r) => [r.kind, r.server]), [["mp4", "YourUpload"]])
  assert.equal(yu[0].headers.Referer, "https://www.yourupload.com/")

  const sw = await ex.extract("https://streamwish.to/e/abc", "Streamwish")
  assert.equal(sw[0].url, "https://swcdn.example.net/hls2/abc/master.m3u8?t=1")
  assert.equal(sw[0].kind, "hls")
  assert.equal(sw[0].headers.Referer, "https://streamwish.to/")

  const mp4u = await ex.extract("https://www.mp4upload.com/embed-abc.html", "Mp4upload")
  assert.equal(mp4u[0].url, "https://a4.mp4upload.com:183/d/abc/video.mp4")

  const jk = await ex.extract(`${JK}/jkplayer/um?e=x-1&t=y`, "JKAnime")
  assert.deepEqual(jk.map((r) => r.url), ["https://cdn.jkdesa.com/hls/x-1/master.m3u8"])
})

test("voe: base64 hls value", async () => {
  http.setFetch(async (href) => response(`<script>var sources = {'hls': '${b64("https://delivery.example.net/engine/hls2/abc/master.m3u8")}', 'video_height': 1080};</script>`, { url: href }))
  const r = await ex.extract("https://voe.sx/e/abc", "VOE")
  assert.equal(r[0].url, "https://delivery.example.net/engine/hls2/abc/master.m3u8")
})

test("mixdrop: MDCore.wurl from packed script", async () => {
  http.setFetch(async (href) => response(`<script>${packed('0.1="2"', ["MDCore", "wurl", "//s-delivery1.mxcontent.net/v/abc.mp4?s=1&e=2"])}</script>`, { url: href }))
  const r = await ex.extract("https://mixdrop.ag/e/abc", "Mixdrop")
  assert.equal(r[0].url, "https://s-delivery1.mxcontent.net/v/abc.mp4?s=1&e=2")
})

test("extractors that find only an embed page return nothing", async () => {
  http.setFetch(async (href) => response(`<html><iframe src="https://other.example.net/embed/abc"></iframe></html>`, { url: href }))
  assert.deepEqual(await ex.extract("https://www.yourupload.com/embed/abc", "YourUpload"), [])
})

test("parseEpisodePage reads var servers and JKAnime players", () => {
  const html = `<h1>Black Clover (TV) - Episodio 5</h1><div class="video_i"><a href="/black-clover-tv/">Black Clover (TV)</a></div>
  <script>video[1] = '<iframe class="player_conte" src="https://jkanime.net/jkplayer/um?e=abc&amp;t=1" width="640"></iframe>';
  var servers = [{"remote":"${b64("https://streamwish.to/e/x")}","server":"Streamwish","lang":1},{"remote":"${b64("https://www.mp4upload.com/embed-y.html")}","server":"Mp4upload","lang":3},{"remote":"${b64("javascript:alert(1)")}","server":"Bad","lang":1}];</script>`
  const page = jkanime.parseEpisodePage(html)
  assert.equal(page.number, 5)
  assert.equal(page.title, "Black Clover (TV)")
  assert.deepEqual(page.servers, [
    { name: "Streamwish", embed: "https://streamwish.to/e/x", lang: 1 },
    { name: "Mp4upload", embed: "https://www.mp4upload.com/embed-y.html", lang: 3 },
  ])
  assert.deepEqual(page.players, ["https://jkanime.net/jkplayer/um?e=abc&t=1"])
})

test("extractJsArray handles brackets inside strings", () => {
  assert.equal(jkanime.extractJsArray('var servers = [{"a":"]x["},[1]]; var y = 2', "servers"), '[{"a":"]x["},[1]]')
  assert.equal(jkanime.extractJsArray("var other = [1]", "servers"), null)
})

test("parseSearch and slugFromHref", () => {
  const html = `<div class="anime__item"><a href="https://jkanime.net/black-clover-tv/"></a><div class="anime__item__text"><ul><li class="anime">Serie</li></ul><h5><a href="https://jkanime.net/black-clover-tv/">Black Clover (TV)</a></h5></div></div>
  <div class="anime__item"><a href="https://evil.example.com/x/"></a><h5>Evil</h5></div>
  <div class="anime__item"><a href="/directorio/"></a><h5>Directorio</h5></div>`
  assert.deepEqual(jkanime.parseSearch(html), [{ title: "Black Clover (TV)", slug: "black-clover-tv", type: "Serie" }])
})

test("parseAnimePage reads type, year and episode count", () => {
  const info = jkanime.parseAnimePage(`<div class="anime__details__content"><div class="anime_info"><h3>Black Clover (TV)</h3></div>
    <ul><li rel="tipo"><span>Tipo:</span> Serie</li><li><span>Episodios:</span> 170</li><li><span>Emitido:</span> Oct 3 de 2017 a Mar 30 de 2021</li><li>Concluido</li></ul></div>`, "black-clover-tv")
  assert.deepEqual([info.title, info.type, info.year, info.episodes, info.status], ["Black Clover (TV)", "Serie", 2017, 170, "finished"])
})
