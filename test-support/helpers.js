/**
 * Offline test doubles. Cinemeta and AniList fixtures are trimmed copies of
 * real responses (fetched 2026-10-13). The JKAnime HTML is SYNTHETIC: it
 * follows the selectors the upstream addon used, because jkanime.net answers
 * this environment with a Cloudflare challenge.
 */
process.env.NODE_ENV = "test"
const http = require("../lib/http")
const metadata = require("../lib/metadata")
const jkanime = require("../lib/jkanime")
const { responseCache } = require("../lib/app")

const JK = "https://jkanime.net"
const b64 = (s) => Buffer.from(s).toString("base64")

/** Minimal P.A.C.K.E.R. output, the format Streamwish/Vidhide/Mixdrop use. */
function packed(payload, words) {
  return `eval(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(new RegExp('\\\\b'+c.toString(a)+'\\\\b','g'),k[c]);return p}('${payload}',36,${words.length},'${words.join("|")}'.split('|'),0,{}))`
}

const DEFAULT_ANIME = {
  "black-clover-tv": { title: "Black Clover (TV)", type: "Serie", emitted: "Oct 3 de 2017", episodes: 170, status: "Concluido" },
  "black-clover-2nd-season": { title: "Black Clover 2nd Season", type: "Serie", emitted: "Oct 3 de 2026", episodes: 2, status: "En emisión" },
  "black-clover-mahou-tei-no-ken": { title: "Black Clover: Mahou Tei no Ken", type: "Pelicula", emitted: "Jun 16 de 2023", episodes: 1, status: "Concluido" },
  "black-clover-jump-festa-2016-special": { title: "Black Clover: Jump Festa 2016 Special", type: "Especial", emitted: "Nov 27 de 2016", episodes: 1, status: "Concluido" },
  "mugyutto-black-clover": { title: "Mugyutto! Black Clover", type: "ONA", emitted: "Abr 2 de 2019", episodes: 8, status: "Concluido" },
}

function searchHtml(items) {
  return `<html><body><div class="page_directorio">${items.map(([slug, a]) => `
    <div class="col-lg-2 col-md-6 col-sm-6"><div class="anime__item">
      <a href="${JK}/${slug}/"><div class="anime__item__pic set-bg" data-setbg="https://cdn.jkdesa.com/assets/images/animes/image/${slug}.jpg"></div></a>
      <div class="anime__item__text"><ul><li class="anime">${a.type}</li><li>${a.status}</li></ul>
      <h5><a href="${JK}/${slug}/">${a.title}</a></h5></div>
    </div></div>`).join("")}</div></body></html>`
}

function animeHtml(slug, a) {
  return `<html><head><meta name="csrf-token" content="tok"></head><body>
  <div class="anime__details__content"><div class="anime_pic"><img src="x.jpg"></div>
  <div class="anime_info"><h3>${a.title}</h3><p class="scroll">Sinopsis</p></div>
  <div class="anime_data"><ul>
    <li rel="tipo"><span>Tipo:</span> ${a.type}</li>
    <li><span>Episodios:</span> ${a.episodes}</li>
    <li><span>Emitido:</span> ${a.emitted}</li>
    <li><div class="enemision">${a.status}</div></li>
  </ul></div><div id="guardar-anime" data-anime="123"></div></div></body></html>`
}

function episodeHtml(slug, n, a, servers) {
  return `<html><body><div class="page-content"><div class="langopcs"><h1>${a.title} - Episodio ${n}</h1></div>
  <div class="video_i"><a href="${JK}/${slug}/">${a.title}</a></div></div>
  <script>
    var video = [];
    video[1] = '<iframe class="player_conte" src="${JK}/jkplayer/um?e=${slug}-${n}&t=x" width="640" height="360" frameborder="0" allowfullscreen></iframe>';
    var servers = ${JSON.stringify(servers(slug, n))};
  </script></body></html>`
}

const defaultServers = (slug, n) => [
  { remote: b64(`https://www.yourupload.com/embed/${slug}${n}`), server: "YourUpload", lang: 1, size: "" },
  { remote: b64(`https://streamwish.to/e/${slug}${n}`), server: "Streamwish", lang: 1 },
  { remote: b64(`https://mega.nz/embed/${slug}${n}`), server: "Mega", lang: 1 },
  { remote: b64(`https://dood.watch/e/${slug}${n}`), server: "Doodstream", lang: 1 },
  { remote: b64(`https://www.mp4upload.com/embed-${slug}${n}.html`), server: "Mp4upload", lang: 3 },
  { remote: b64("http://127.0.0.1:8080/e/evil"), server: "Streamwish", lang: 1 },
  { remote: "not-base64-!!", server: "Broken", lang: 1 },
]

function response(body, { status = 200, url, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: new Headers(headers),
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  }
}

/**
 * Installs a fake fetch that serves Cinemeta, AniList and a fake JKAnime site.
 * @param {object} opts
 *   anime: JKAnime entries (slug -> info); search: list of slugs the search returns
 *   blocked: serve the Cloudflare challenge for every jkanime.net request
 */
function installFakeNet({ anime = DEFAULT_ANIME, servers = defaultServers, blocked = false, cinemeta, anilist, calls = [] } = {}) {
  const cinemetaFixtures = { "series/tt7441658": require("../test/fixtures/cinemeta-black-clover.json"), ...(cinemeta || {}) }
  const anilistFixture = anilist || require("../test/fixtures/anilist-black-clover.json")
  http.setFetch(async (href, opts = {}) => {
    const url = new URL(href)
    calls.push(url.href)
    if (url.hostname === "v3-cinemeta.strem.io") {
      const key = url.pathname.replace(/^\/meta\//, "").replace(/\.json$/, "")
      return cinemetaFixtures[key] ? response(cinemetaFixtures[key]) : response({}, { status: 404 })
    }
    if (url.hostname === "graphql.anilist.co") return response(anilistFixture)
    if (url.hostname === "jkanime.net") {
      if (blocked) {
        return response("<html><head><title>Just a moment...</title></head><body>challenges.cloudflare.com</body></html>",
          { status: 403, headers: { "cf-mitigated": "challenge" } })
      }
      const parts = url.pathname.split("/").filter(Boolean)
      if (parts[0] === "buscar") {
        const q = decodeURIComponent(parts[1] || "").toLowerCase()
        const words = q.split(/\s+/).filter((w) => w.length > 2)
        const items = Object.entries(anime).filter(([, a]) => words.every((w) => a.title.toLowerCase().includes(w)))
        return response(searchHtml(items), { url: href })
      }
      if (parts[0] === "jkplayer") {
        const e = url.searchParams.get("e")
        return response(`<html><script>var player = new Player({ url: 'https://cdn.jkdesa.com/hls/${e}/master.m3u8', poster: 'p.jpg' });</script></html>`, { url: href })
      }
      const a = anime[parts[0]]
      if (!a) return response("not found", { status: 404, url: href })
      if (parts.length === 1) return response(animeHtml(parts[0], a), { url: href })
      const n = Number(parts[1])
      // JKAnime redirects missing episodes to the anime page.
      if (!(n >= 1 && n <= a.episodes)) return response(animeHtml(parts[0], a), { url: `${JK}/${parts[0]}/` })
      return response(episodeHtml(parts[0], n, a, servers), { url: href })
    }
    if (url.hostname === "www.yourupload.com") {
      return response(`<html><head><meta property="og:video" content="https://vidcache.net:8161/a20260101/v/${url.pathname.split("/").pop()}.mp4"></head></html>`, { url: href })
    }
    if (url.hostname === "streamwish.to") {
      const id = url.pathname.split("/").pop()
      return response(`<html><script type="text/javascript">${packed('0({1:[{2:"3"}]})', ["jwplayer", "sources", "file", `https://swcdn.example.net/hls2/${id}/master.m3u8?t=1`])}</script></html>`, { url: href })
    }
    if (url.hostname === "www.mp4upload.com") {
      const id = url.pathname.match(/embed-(.+)\.html/)[1]
      return response(`<html><script>player.src({ type: "video/mp4", src: "https://a4.mp4upload.com:183/d/${id}/video.mp4" });</script></html>`, { url: href })
    }
    throw new Error(`unexpected request in test: ${href}`)
  })
  return calls
}

function resetAll() {
  http.resetFetch()
  metadata.cache.clear()
  jkanime.caches.forEach((c) => c.clear())
  responseCache.clear()
}

module.exports = { installFakeNet, resetAll, packed, response, DEFAULT_ANIME, defaultServers, b64, JK }
