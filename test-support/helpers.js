/**
 * Offline test doubles.
 * REAL (trimmed copies of responses fetched 2026-10-13): Cinemeta, AniList
 * searches, relations.yuna.moe and api.ani.zip (test/fixtures/*.json).
 * SYNTHETIC: TMDB and TVDB API responses (no credentials were available; the
 * shapes follow their public API docs and use the real ids/titles seen on
 * themoviedb.org/tv/285710 and thetvdb.com/series/gensou-suikoden), and the
 * JKAnime / video host HTML (follows the selectors of the upstream addon).
 */
process.env.NODE_ENV = "test"
const http = require("../lib/utils/http")
const common = require("../lib/providers/common")
const tvdb = require("../lib/providers/tvdb")
const jkanime = require("../lib/jkanime/site")
const { responseCache } = require("../lib/app")

// Dummy credentials, never real ones.
const FAKE = { tmdbToken: "test-tmdb-token", tmdbKey: "test-tmdb-key", tvdbKey: "test-tvdb-key", tvdbPin: "0000" }
const CRED_VARS = ["TMDB_API_READ_TOKEN", "TMDB_API_KEY", "TVDB_API_KEY", "TVDB_SUBSCRIBER_PIN", "METADATA_PROVIDER", "CINEMETA_ENABLED", "RELATIONS_ENABLED"]
function setCredentials({ tmdb = true, tmdbKeyOnly = false, tvdb: tv = true, pin = false, provider } = {}) {
  for (const v of CRED_VARS) delete process.env[v]
  if (tmdb && !tmdbKeyOnly) process.env.TMDB_API_READ_TOKEN = FAKE.tmdbToken
  if (tmdb && tmdbKeyOnly) process.env.TMDB_API_KEY = FAKE.tmdbKey
  if (tv) process.env.TVDB_API_KEY = FAKE.tvdbKey
  if (pin) process.env.TVDB_SUBSCRIBER_PIN = FAKE.tvdbPin
  if (provider) process.env.METADATA_PROVIDER = provider
}
const clearCredentials = () => { for (const v of CRED_VARS) delete process.env[v] }

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
  "gensou-suikoden": { title: "Gensou Suikoden", type: "Serie", emitted: "Oct 3 de 2026", episodes: 2, status: "En emisión" },
}

const days = (start, n, step = 7) => Array.from({ length: n }, (_, i) => new Date(Date.parse(start) + i * step * 864e5).toISOString().slice(0, 10))

/** SYNTHETIC TMDB data (see header). */
const TMDB = {
  find: {
    tt7441658: { tv_results: [{ id: 73223 }], movie_results: [] },
    // themoviedb.org/tv/285710 shows no IMDb link, so /find is modelled as empty.
    tt42938834: { tv_results: [], movie_results: [] },
  },
  tv: {
    73223: {
      id: 73223, name: "Black Clover", original_name: "ブラッククローバー", first_air_date: "2017-10-03", genres: [{ id: 16 }],
      seasons: [
        { season_number: 0, episode_count: 19, air_date: "2016-11-27" },
        { season_number: 1, episode_count: 51, air_date: "2017-10-03" },
        { season_number: 2, episode_count: 51, air_date: "2018-10-09" },
        { season_number: 3, episode_count: 52, air_date: "2019-10-01" },
        { season_number: 4, episode_count: 16, air_date: "2020-10-06" },
      ],
      alternative_titles: { results: [{ title: "Black Clover" }, { title: "Burakku Kurōbā" }, { title: "ブラッククローバー" }] },
      translations: { translations: [{ iso_639_1: "es", data: { name: "Black Clover" } }] },
      external_ids: { imdb_id: "tt7441658", tvdb_id: 331753 },
    },
    285710: {
      id: 285710, name: "Suikoden: The Anime", original_name: "幻想水滸伝", first_air_date: "2026-10-03", genres: [{ id: 16 }],
      seasons: [{ season_number: 1, episode_count: 23, air_date: "2026-10-03" }],
      alternative_titles: { results: [{ title: "Gensou Suikoden" }] },
      translations: { translations: [] },
      external_ids: { imdb_id: null, tvdb_id: 482279 },
    },
  },
}

/** SYNTHETIC TVDB v4 data (see header). */
const TVDB = {
  remoteid: {
    tt42938834: [{ series: { id: 482279, name: "幻想水滸伝" } }],
    tt7441658: [{ series: { id: 331753, name: "Black Clover" } }],
  },
  series: {
    482279: {
      id: 482279, name: "幻想水滸伝", year: "2026", firstAired: "2026-10-03",
      aliases: [{ language: "jpn", name: "Gensou Suikoden" }, { language: "eng", name: "Suikoden" }],
      translations: { nameTranslations: [{ language: "eng", name: "Suikoden: The Anime" }, { language: "fra", name: "Suikoden : L'Anime" }, { language: "jpn", name: "幻想水滸伝" }] },
      remoteIds: [{ id: "tt42938834", sourceName: "IMDB" }, { id: "285710", sourceName: "TheMovieDB.com" }],
      seasons: [{ number: 0, type: { type: "official" } }, { number: 1, type: { type: "official" } }, { number: 1, type: { type: "absolute" } }],
    },
    331753: {
      id: 331753, name: "Black Clover", year: "2017", firstAired: "2017-10-03", aliases: [],
      translations: { nameTranslations: [{ language: "eng", name: "Black Clover" }] },
      remoteIds: [{ id: "tt7441658", sourceName: "IMDB" }, { id: "73223", sourceName: "TheMovieDB.com" }],
      seasons: [{ number: 1, type: { type: "official" } }, { number: 1, type: { type: "absolute" } }],
    },
  },
  episodes: {
    "482279:default": days("2026-10-03", 2).map((d, i) => ({ seasonNumber: 1, number: i + 1, aired: d })),
    "482279:official": days("2026-10-03", 2).map((d, i) => ({ seasonNumber: 1, number: i + 1, aired: d })),
    "331753:default": [51, 51, 52, 16].flatMap((n, s) => days(`${2017 + s}-10-03`, n).map((d, i) => ({ seasonNumber: s + 1, number: i + 1, aired: d }))),
    "331753:absolute": days("2017-10-03", 170).map((d, i) => ({ seasonNumber: 1, number: i + 1, aired: d })),
  },
}

const RELATIONS = require("../test/fixtures/relations.json")
const ANILIST_SEARCHES = {
  clover: require("../test/fixtures/anilist-black-clover.json"),
  ...Object.fromEntries(Object.entries(require("../test/fixtures/anilist-suikoden-searches.json")).map(([k, v]) => [k.toLowerCase(), v])),
}
const ALL_MEDIA = Object.values(ANILIST_SEARCHES).flatMap((j) => j.data.Page.media)

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
function installFakeNet({
  anime = DEFAULT_ANIME, servers = defaultServers, blocked = false, cinemeta, anilist, calls = [],
  tmdb = TMDB, tvdbData = TVDB, down = [], stats = { tvdbLogins: 0, requests: [] },
} = {}) {
  const cinemetaFixtures = { "series/tt7441658": require("../test/fixtures/cinemeta-black-clover.json"), ...(cinemeta || {}) }
  http.setFetch(async (href, opts = {}) => {
    const url = new URL(href)
    calls.push(url.href)
    stats.requests.push({ url: url.href, headers: opts.headers || {}, body: opts.body })
    const isDown = down.find((d) => url.hostname.includes(d))
    if (isDown) return response("Service Unavailable", { status: 503 })
    if (url.hostname === "v3-cinemeta.strem.io") {
      const key = url.pathname.replace(/^\/meta\//, "").replace(/\.json$/, "")
      // Cinemeta answers {} for ids it does not know (real behaviour for tt42938834).
      return response(cinemetaFixtures[key] || {})
    }
    if (url.hostname === "graphql.anilist.co") {
      const { variables = {} } = JSON.parse(opts.body || "{}")
      if (variables.s !== undefined) {
        if (anilist) return response(anilist)
        const s = String(variables.s).toLowerCase()
        const fx = ANILIST_SEARCHES[s] || (s.includes("clover") ? ANILIST_SEARCHES.clover : null)
        return response(fx || { data: { Page: { media: [] } } })
      }
      const media = ALL_MEDIA.find((m) => m.id === variables.id || m.idMal === variables.id) || null
      return response({ data: { Media: media } })
    }
    if (url.hostname === "api.themoviedb.org") {
      const auth = opts.headers?.Authorization === `Bearer ${FAKE.tmdbToken}` || url.searchParams.get("api_key") === FAKE.tmdbKey
      if (!auth) return response({ status_code: 7, status_message: "Invalid API key" }, { status: 401 })
      const p = url.pathname.replace(/^\/3/, "").split("/").filter(Boolean)
      if (p[0] === "find") return response(tmdb.find[p[1]] || { tv_results: [], movie_results: [] })
      if (p[0] === "tv" && tmdb.tv[p[1]]) return response(tmdb.tv[p[1]])
      return response({ status_code: 34 }, { status: 404 })
    }
    if (url.hostname === "api4.thetvdb.com") {
      const p = url.pathname.replace(/^\/v4/, "").split("/").filter(Boolean)
      if (p[0] === "login") {
        stats.tvdbLogins++
        const body = JSON.parse(opts.body || "{}")
        if (body.apikey !== FAKE.tvdbKey) return response({ status: "failure", message: "Unauthorized" }, { status: 401 })
        return response({ status: "success", data: { token: `tvdb-session-${stats.tvdbLogins}` } })
      }
      const valid = stats.revokeTvdbToken ? `Bearer tvdb-session-${stats.tvdbLogins}` : null
      const authz = opts.headers?.Authorization || ""
      if (!/^Bearer tvdb-session-\d+$/.test(authz) || (valid && authz !== valid)) return response({ message: "Unauthorized" }, { status: 401 })
      if (p[0] === "search" && p[1] === "remoteid") return response({ status: "success", data: tvdbData.remoteid[p[2]] || [] })
      if (p[0] === "series" && p[2] === "extended" && tvdbData.series[p[1]]) return response({ status: "success", data: tvdbData.series[p[1]] })
      if (p[0] === "series" && p[2] === "episodes") {
        const eps = tvdbData.episodes[`${p[1]}:${p[3]}`]
        if (!eps) return response({ status: "failure" }, { status: 404 })
        const page = Number(url.searchParams.get("page")) || 0
        const size = 100
        const slice = eps.slice(page * size, page * size + size)
        return response({ status: "success", data: { episodes: slice }, links: { next: (page + 1) * size < eps.length ? "next" : null } })
      }
      return response({ status: "failure" }, { status: 404 })
    }
    if (url.hostname === "relations.yuna.moe") {
      const src = url.searchParams.get("source") === "myanimelist" ? "mal" : url.searchParams.get("source")
      const hit = RELATIONS[`yuna:${src}:${url.searchParams.get("id")}`]
      return hit ? response(hit) : response({ message: "Validation error", statusCode: 400 }, { status: 400 })
    }
    if (url.hostname === "api.ani.zip") {
      const [[k, v]] = [...url.searchParams.entries()]
      const hit = RELATIONS[`anizip:${k}:${v}`]
      return hit ? response(hit) : response("Not Found", { status: 404 })
    }
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
  common.cache.clear()
  common.mappingCache.clear()
  tvdb.resetSession()
  clearCredentials()
  jkanime.caches.forEach((c) => c.clear())
  responseCache.clear()
}

module.exports = { installFakeNet, resetAll, packed, response, DEFAULT_ANIME, defaultServers, b64, JK, TMDB, TVDB, FAKE, setCredentials, clearCredentials }
