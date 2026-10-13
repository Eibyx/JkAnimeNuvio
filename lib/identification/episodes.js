/**
 * Episode numbering helpers. JKAnime numbers every entry from 1, while
 * Cinemeta/TMDB may group several JKAnime entries (or a slice of one) under
 * a season number.
 */

/** Parses "tt123:2:5", "tmdb:1:2:5", "tvdb:1:2:5", "kitsu:13209:5", "mal:34572", ... into its parts. */
function parseVideoId(rawId) {
  let id
  try { id = decodeURIComponent(String(rawId || "")).trim() } catch { return null }
  if (id.length > 64) return null
  const parts = id.split(":")
  const int = (v) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined)

  if (/^tt\d+$/.test(parts[0])) {
    if (parts.length === 1) return { source: "imdb", id: parts[0] }
    if (parts.length === 3 && int(parts[1]) !== undefined && int(parts[2]) !== undefined) {
      return { source: "imdb", id: parts[0], season: int(parts[1]), episode: int(parts[2]) }
    }
    return null
  }
  if (["kitsu", "mal", "anilist"].includes(parts[0]) && int(parts[1]) !== undefined) {
    if (parts.length === 2) return { source: parts[0], id: parts[1] }
    if (parts.length === 3 && int(parts[2]) !== undefined) return { source: parts[0], id: parts[1], episode: int(parts[2]) }
    // kitsu:ID:season:episode is not standard, but some clients send it.
    if (parts.length === 4 && int(parts[3]) !== undefined) return { source: parts[0], id: parts[1], episode: int(parts[3]) }
    return null
  }
  if ((parts[0] === "tmdb" || parts[0] === "tvdb") && int(parts[1]) !== undefined) {
    if (parts.length === 2) return { source: parts[0], id: parts[1] }
    if (parts.length === 4 && int(parts[2]) !== undefined && int(parts[3]) !== undefined) {
      return { source: parts[0], id: parts[1], season: int(parts[2]), episode: int(parts[3]) }
    }
  }
  return null
}

/**
 * Converts season/episode to a continuous episode number, e.g. TMDB's
 * Black Clover S2E1 -> 52. Returns null when an earlier season is unknown.
 */
function toAbsolute(layout, season, episode) {
  if (!layout || season < 1 || episode < 1) return null
  let offset = 0
  for (let s = 1; s < season; s++) {
    if (!layout[s]) return null
    offset += Math.max(layout[s].count, layout[s].maxEpisode || 0)
  }
  return offset + episode
}

module.exports = { parseVideoId, toAbsolute }
