/**
 * Expiry time of signed media URLs, read only from formats that state it
 * explicitly. Anything else returns null (unknown), never a guess.
 *
 * Recognised:
 * - expires / expire / exp / Expires = unix seconds (CDNs, CloudFront, Akamai-style)
 * - X-Amz-Date (yyyymmddThhmmssZ) + X-Amz-Expires (seconds): AWS SigV4
 * - s = start (unix seconds) + e = lifetime (seconds): Streamwish/JW-style
 *   ("...master.m3u8?t=…&s=1700000000&e=129600&f=…")
 */
const NOW_WINDOW = { past: 2 * 86400, future: 60 * 86400 } // plausible unix timestamps around now

const plausibleUnix = (n, now) => Number.isInteger(n) && n > now / 1000 - NOW_WINDOW.past && n < now / 1000 + NOW_WINDOW.future

function amzDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s || "")
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null
}

/**
 * @param {string} value - media URL
 * @param {number} [now]
 * @returns {number|null} expiry as epoch milliseconds, or null when unknown
 */
function urlExpiry(value, now = Date.now()) {
  let url
  try { url = new URL(value) } catch { return null }
  const p = url.searchParams
  const get = (...names) => names.map((n) => p.get(n)).find((v) => v !== null && v !== "")
  const out = []

  const abs = Number(get("expires", "Expires", "expire", "exp"))
  if (plausibleUnix(abs, now)) out.push(abs * 1000)

  const date = amzDate(get("X-Amz-Date", "x-amz-date"))
  const life = Number(get("X-Amz-Expires", "x-amz-expires"))
  if (date && Number.isFinite(life) && life > 0) out.push(date + life * 1000)

  const start = Number(p.get("s"))
  const e = Number(p.get("e"))
  if (plausibleUnix(start, now) && Number.isInteger(e) && e > 0 && e < NOW_WINDOW.future) out.push((start + e) * 1000)
  else if (plausibleUnix(e, now)) out.push(e * 1000)

  return out.length ? Math.min(...out) : null
}

module.exports = { urlExpiry }
