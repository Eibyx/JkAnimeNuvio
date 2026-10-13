/**
 * Classifies IP addresses that must never be contacted: loopback, private,
 * link-local, carrier-grade NAT, documentation/benchmark ranges, multicast and
 * reserved space, including IPv4 addresses embedded in IPv6 (mapped,
 * compatible, NAT64 and 6to4 forms).
 */
const net = require("node:net")

/** @returns {number[]|null} the 4 octets */
function parseIPv4(ip) {
  if (net.isIPv4(ip) !== true) return null
  return ip.split(".").map(Number)
}

function isBlockedIPv4(octets) {
  const [a, b, c] = octets
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||          // 100.64.0.0/10 carrier-grade NAT
    (a === 169 && b === 254) ||                    // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // 192.0.0.0/24, 192.0.2.0/24
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||       // 198.18.0.0/15 benchmarking
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224                                       // multicast, reserved, broadcast
}

/** Expands an IPv6 literal (without brackets) to 8 16-bit groups. */
function parseIPv6(ip) {
  let s = String(ip).toLowerCase()
  if (net.isIPv6(s) !== true) return null
  s = s.replace(/%.*$/, "")
  // A trailing dotted IPv4 becomes two groups.
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const o = parseIPv4(dotted[1])
    if (!o) return null
    s = s.slice(0, -dotted[1].length) + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16)
  }
  const [head, tail] = s.includes("::") ? s.split("::") : [s, null]
  const h = head ? head.split(":") : []
  const t = tail ? tail.split(":") : []
  const fill = tail === null ? [] : Array(8 - h.length - t.length).fill("0")
  const groups = [...h, ...fill, ...t].map((g) => parseInt(g, 16))
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null
}

const v4From = (hi, lo) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]

function isBlockedIPv6(g) {
  const zeros = (n) => g.slice(0, n).every((x) => x === 0)
  if (zeros(8)) return true                                   // ::
  if (zeros(7) && g[7] === 1) return true                     // ::1
  if (zeros(5) && g[5] === 0xffff) return isBlockedIPv4(v4From(g[6], g[7])) // ::ffff:a.b.c.d
  if (zeros(6)) return true                                   // ::a.b.c.d (deprecated, never public)
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (g[2] === 1) return true                               // 64:ff9b:1::/48 local-use NAT64
    if (zeros(6) || g.slice(2, 6).every((x) => x === 0)) return isBlockedIPv4(v4From(g[6], g[7]))
  }
  if (g[0] === 0x2002) return isBlockedIPv4(v4From(g[1], g[2])) // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true              // Teredo (hides the real IPv4)
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true          // documentation
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true // discard-only
  if ((g[0] & 0xfe00) === 0xfc00) return true                 // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true                 // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true                 // fec0::/10 site-local
  if ((g[0] & 0xff00) === 0xff00) return true                 // multicast
  return false
}

/**
 * @param {string} ip - IPv4 or IPv6 literal (brackets allowed)
 * @returns {boolean} true when the address is not a public unicast address
 */
function isBlockedIp(ip) {
  const s = String(ip || "").replace(/^\[|\]$/g, "")
  const v4 = parseIPv4(s)
  if (v4) return isBlockedIPv4(v4)
  const v6 = parseIPv6(s)
  if (v6) return isBlockedIPv6(v6)
  return true // not an IP literal: callers only pass literals
}

module.exports = { isBlockedIp, parseIPv6 }
