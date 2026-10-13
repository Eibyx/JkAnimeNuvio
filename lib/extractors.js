/**
 * Turns embed pages of the servers JKAnime lists into direct media URLs.
 * Only MP4 or HLS (m3u8) URLs leave this module; embed pages, iframes and
 * download pages are never returned.
 */
const crypto = require("node:crypto")
const cheerio = require("cheerio")
const unpacker = require("unpacker")
const { fetchText, fetchJson, request, safeUrl } = require("./http")
const { JKANIME_BASE } = require("./jkanime")

const JK_HOST = new URL(JKANIME_BASE).hostname

// Hosts that serve media without a file extension in the URL.
const DIRECT_PATTERNS = [
  /^https?:\/\/[^/]*pixeldrain\.[a-z]+\/api\/file\/[\w-]+/i,
  /^https?:\/\/[^/]*(?:streamtape|tapecontent|stape)\.[a-z]+\/get_video\?/i,
]
const NOT_MEDIA = /\.(?:html?|php|js|css|png|jpe?g|gif|webp|svg|vtt|srt)(?:[?#]|$)/i
const AD_OR_SAMPLE = /googletagmanager|google-analytics|doubleclick|bigbuckbunny|sample-video|test-videos|placeholder/i

/** @returns {"hls"|"mp4"|null} */
function mediaKind(value) {
  const url = safeUrl(value)
  if (!url || AD_OR_SAMPLE.test(url.href)) return null
  const path = url.pathname.toLowerCase()
  if (/\.m3u8$/.test(path) || /\/(?:master|index|playlist)\.m3u8/.test(path) || /[?&](?:type|format)=m3u8\b/i.test(url.search)) return "hls"
  if (/\.mp4$/.test(path) || /[?&](?:type|format)=mp4\b/i.test(url.search)) return "mp4"
  if (NOT_MEDIA.test(path)) return null
  if (DIRECT_PATTERNS.some((re) => re.test(url.href))) return "mp4"
  return null
}
exports.mediaKind = mediaKind

function cleanUrl(value, base) {
  if (!value || typeof value !== "string") return null
  let v = value.trim()
    .replace(/\\u0026/g, "&").replace(/\\u002F/gi, "/").replace(/\\\//g, "/").replace(/&amp;/g, "&")
  if (v.startsWith("//")) v = "https:" + v
  const url = safeUrl(v, base)
  return url ? url.href : null
}
exports.cleanUrl = cleanUrl

const MEDIA_URL_RE = /(?:https?:)?\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>\\]*)?(?=["'\s<>\\]|$)/gi

/** All direct-looking media URLs in a blob of HTML/JS, HLS first. */
function findMediaUrls(text, base) {
  const out = []
  for (const m of String(text || "").matchAll(MEDIA_URL_RE)) {
    const url = cleanUrl(m[0], base)
    if (url && mediaKind(url) && !out.includes(url)) out.push(url)
  }
  return out.sort((a, b) => (mediaKind(a) === "hls" ? 0 : 1) - (mediaKind(b) === "hls" ? 0 : 1))
}
exports.findMediaUrls = findMediaUrls

/** Unpacks Dean Edwards packed scripts (eval(function(p,a,c,k,e,d)...)) without evaluating them. */
function unpackScripts(html) {
  const out = []
  const $ = cheerio.load(html)
  const sources = $("script").map((_, el) => $(el).html() || "").get()
  if (sources.length === 0) sources.push(String(html))
  for (const src of sources) {
    let idx = src.indexOf("eval(function(p,a,c,k,e,")
    while (idx !== -1) {
      const chunk = src.slice(idx)
      try {
        if (unpacker.detect(chunk)) out.push(unpacker.unpack(chunk))
      } catch { /* not unpackable, try the next one */ }
      idx = src.indexOf("eval(function(p,a,c,k,e,", idx + 1)
    }
  }
  return out
}
exports.unpackScripts = unpackScripts

const originOf = (url) => new URL(url).origin
const refererHeaders = (embed) => ({ Referer: originOf(embed) + "/", Origin: originOf(embed) })

/* ---------------------------------------------------------------- extractors */

async function jkanimePlayer(embed) {
  const url = new URL(embed)
  // jk.php?u=stream/jkmedia/... points straight at a file on JKAnime.
  const u = url.searchParams.get("u")
  if (u) {
    const direct = cleanUrl(u, JKANIME_BASE + "/")
    if (direct && mediaKind(direct)) return [{ url: direct, headers: { Referer: JKANIME_BASE + "/" } }]
  }
  const html = await fetchText(embed, { referer: JKANIME_BASE + "/" })
  const $ = cheerio.load(html)
  const found = []
  $("video source[src], video[src]").each((_, el) => {
    const src = cleanUrl($(el).attr("src"), embed)
    if (src && mediaKind(src)) found.push(src)
  })
  found.push(...findMediaUrls(html, embed))
  for (const unpacked of unpackScripts(html)) found.push(...findMediaUrls(unpacked, embed))
  return [...new Set(found)].map((m) => ({ url: m, headers: { Referer: JKANIME_BASE + "/", Origin: JKANIME_BASE } }))
}

async function yourUpload(embed) {
  const html = await fetchText(embed, { referer: "https://www.yourupload.com/" })
  const $ = cheerio.load(html)
  const og = cleanUrl($('meta[property="og:video"]').attr("content"), embed)
  const urls = [og, ...findMediaUrls(html, embed)].filter((u) => u && !/novideo\.mp4/.test(u) && mediaKind(u))
  return [...new Set(urls)].map((m) => ({ url: m, headers: { Referer: "https://www.yourupload.com/" } }))
}

async function mp4Upload(embed) {
  const html = await fetchText(embed, { referer: "https://www.mp4upload.com/" })
  const m = html.match(/src\s*:\s*["']([^"']+\.mp4[^"']*)["']/i) || html.match(/<source[^>]+src=["']([^"']+\.mp4[^"']*)["']/i)
  const url = cleanUrl(m?.[1], embed)
  return url && mediaKind(url) ? [{ url, headers: { Referer: "https://www.mp4upload.com/" } }] : []
}

/** Streamwish / Vidhide / Filelions family: JW Player config, usually packed. */
async function jwPacked(embed) {
  let html = await fetchText(embed, { referer: originOf(embed) + "/" })
  const iframe = html.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1]
  if (!findMediaUrls(html, embed).length && iframe && safeUrl(iframe, embed)) {
    embed = safeUrl(iframe, embed).href
    html = await fetchText(embed, { referer: originOf(embed) + "/" })
  }
  const urls = [...findMediaUrls(html, embed)]
  for (const unpacked of unpackScripts(html)) urls.push(...findMediaUrls(unpacked, embed))
  return [...new Set(urls)].map((m) => ({ url: m, headers: refererHeaders(embed) }))
}

function rot13(s) {
  return s.replace(/[a-z]/gi, (c) => String.fromCharCode((c <= "Z" ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26))
}

/** Voe: plain `'hls': '...'`, base64-encoded hls, or the obfuscated JSON blob. */
async function voe(embed) {
  let { text: html, url: finalUrl } = await request(embed)
  const redirect = html.match(/window\.location\.href\s*=\s*['"](https?:\/\/[^'"]+)['"]/i)?.[1]
  if (redirect && safeUrl(redirect)) ({ text: html, url: finalUrl } = await request(redirect, { referer: embed }))
  const found = []
  for (const m of html.matchAll(/['"](?:hls|mp4|file|direct_access_url)['"]\s*:\s*['"]([^'"]+)['"]/gi)) {
    let v = m[1]
    if (!/^(?:https?:)?\/\//.test(v)) {
      try { v = Buffer.from(v, "base64").toString("utf8") } catch { continue }
    }
    const url = cleanUrl(v, finalUrl)
    if (url && mediaKind(url)) found.push(url)
  }
  // Newer pages: <script type="application/json">["<obfuscated>"]</script>
  const blob = html.match(/<script type="application\/json">\s*\[\s*"([^"]+)"\s*\]\s*<\/script>/i)?.[1]
  if (blob) {
    try {
      let s = rot13(blob)
      for (const junk of ["@$", "^^", "~@", "%?", "*~", "!!", "#&"]) s = s.split(junk).join("")
      s = Buffer.from(s, "base64").toString("utf8")
      s = [...s].map((c) => String.fromCharCode(c.charCodeAt(0) - 3)).join("")
      s = Buffer.from(s.split("").reverse().join(""), "base64").toString("utf8")
      const data = JSON.parse(s)
      for (const key of ["source", "direct_access_url", "hls", "file"]) {
        const url = cleanUrl(data?.[key], finalUrl)
        if (url && mediaKind(url)) found.push(url)
      }
    } catch { /* format changed, nothing to extract */ }
  }
  found.push(...findMediaUrls(html, finalUrl))
  return [...new Set(found)].map((m) => ({ url: m, headers: refererHeaders(finalUrl) }))
}

/** Filemoon: the player's own /api/videos/{code} playback payload (AES-GCM). */
async function filemoon(embed) {
  const code = new URL(embed).pathname.match(/\/[ed]\/([\w-]+)/)?.[1]
  if (!code) return []
  const data = await fetchJson(`${originOf(embed)}/api/videos/${code}`, { referer: embed })
  const pb = data?.playback
  if (!pb?.key_parts || !pb.payload || !pb.iv) return []
  const key = Buffer.concat(pb.key_parts.map((p) => Buffer.from(p, "base64url")))
  const payload = Buffer.from(pb.payload, "base64url")
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(pb.iv, "base64url"))
  decipher.setAuthTag(payload.subarray(-16))
  const plain = decipher.update(payload.subarray(0, -16), undefined, "utf8") + decipher.final("utf8")
  const sources = JSON.parse(plain)?.sources || []
  return sources
    .map((s) => cleanUrl(s?.url, embed))
    .filter((u) => u && mediaKind(u))
    .map((u) => ({ url: u, headers: refererHeaders(embed) }))
}

async function mixdrop(embed) {
  const url = embed.replace(/\/f\//, "/e/")
  const html = await fetchText(url)
  const found = []
  for (const unpacked of unpackScripts(html)) {
    const wurl = unpacked.match(/MDCore\.wurl\s*=\s*"([^"]+)"/)?.[1]
    const direct = cleanUrl(wurl, url)
    if (direct && mediaKind(direct)) found.push(direct)
  }
  return [...new Set(found)].map((m) => ({ url: m, headers: refererHeaders(url) }))
}

async function streamtape(embed) {
  const html = await fetchText(embed.replace("/v/", "/e/"))
  const m = html.match(/getElementById\(['"](?:robotlink|norobotlink)['"]\)\.innerHTML\s*=\s*['"]([^'"]+)['"]\s*\+\s*\(?['"]([^'"]+)['"]\)?(?:\.substring\((\d+)\))?(?:\.substring\((\d+)\))?/)
  if (!m) return []
  let tail = m[2]
  if (m[3]) tail = tail.substring(Number(m[3]))
  if (m[4]) tail = tail.substring(Number(m[4]))
  const url = cleanUrl(("https:" + m[1] + tail).replace(/^https:(?!\/\/)/, "https://"), embed)
  return url && mediaKind(url) ? [{ url: url + (url.includes("stream=") ? "" : "&stream=1"), headers: refererHeaders(embed) }] : []
}

async function pixeldrain(embed) {
  const id = new URL(embed).pathname.match(/\/(?:u|l|api\/file)\/([\w-]+)/)?.[1]
  if (!id) return []
  return [{ url: `${originOf(embed)}/api/file/${id}`, headers: {} }]
}

async function okru(embed) {
  const html = await fetchText(embed.replace("/video/", "/videoembed/"))
  const $ = cheerio.load(html)
  const options = JSON.parse($('div[data-module="OKVideo"]').attr("data-options") || "{}")
  const meta = JSON.parse(options?.flashvars?.metadata || "{}")
  const urls = [meta.hlsManifestUrl, meta.hlsMasterPlaylistUrl, meta.ondemandHls]
    .map((u) => cleanUrl(u, embed)).filter((u) => u && mediaKind(u) === "hls")
  return [...new Set(urls)].map((u) => ({ url: u, headers: { Referer: "https://ok.ru/" } }))
}

const EXTRACTORS = [
  { key: "jkanime", label: "JKAnime", host: (h) => h === JK_HOST || h.endsWith(".jkanime.net"), fn: jkanimePlayer },
  { key: "yourupload", label: "YourUpload", host: (h) => /yourupload/.test(h), fn: yourUpload },
  { key: "mp4upload", label: "MP4Upload", host: (h) => /mp4upload/.test(h), fn: mp4Upload },
  { key: "streamwish", label: "Streamwish", host: (h) => /wish|swdyu|dhcplay|ghbrisk|hgplaycdn|cybervynx|kravaxxa|dumbalag/.test(h), name: /wish|^sw$/, fn: jwPacked },
  { key: "vidhide", label: "Vidhide", host: (h) => /vidhide|filelions|lions|movearnpre|smoothpre|ryderjet|dhtpre/.test(h), name: /vidhide|lions/, fn: jwPacked },
  { key: "voe", label: "VOE", host: (h) => /(^|\.)voe\./.test(h), name: /^voe$/, fn: voe },
  { key: "filemoon", label: "Filemoon", host: (h) => /filemoon|moonplayer|bysesukior|kerapoxy/.test(h), name: /filemoon/, fn: filemoon },
  { key: "mixdrop", label: "Mixdrop", host: (h) => /m[i1]?x+drop|mxdrop/.test(h), name: /mixdrop/, fn: mixdrop },
  { key: "streamtape", label: "Streamtape", host: (h) => /streamtape|strtape|stape|tapecontent/.test(h), name: /streamtape|stape/, fn: streamtape },
  { key: "pixeldrain", label: "PixelDrain", host: (h) => /pixeldrain/.test(h), fn: pixeldrain },
  { key: "okru", label: "Okru", host: (h) => /(^|\.)ok\.ru$/.test(h), fn: okru },
]

/** Finds the extractor for an embed URL (by host, then by JKAnime's server name). */
function pickExtractor(embed, serverName = "") {
  const url = safeUrl(embed)
  if (!url) return null
  const host = url.hostname.toLowerCase()
  const name = serverName.toLowerCase().trim()
  return EXTRACTORS.find((e) => e.host(host)) || EXTRACTORS.find((e) => e.name && e.name.test(name)) || null
}
exports.pickExtractor = pickExtractor

/**
 * @returns {Promise<Array<{url, kind, headers, server}>>} only direct MP4/HLS
 */
exports.extract = async function extract(embed, serverName) {
  const ex = pickExtractor(embed, serverName)
  if (!ex) return []
  const results = await ex.fn(embed)
  return results
    .filter((r) => r && mediaKind(r.url))
    .map((r) => ({ url: r.url, kind: mediaKind(r.url), headers: r.headers || {}, server: ex.label, serverKey: ex.key }))
}
