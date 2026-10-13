const pkg = require("../package.json")
const { hasTmdb } = require("./metadata")

const TYPES = ["series", "movie", "anime"]
exports.TYPES = TYPES

/** Stream-only manifest: no catalogs, no meta. */
exports.buildManifest = function buildManifest(config = {}) {
  const idPrefixes = ["tt", "kitsu:", "mal:", "anilist:", ...(hasTmdb() ? ["tmdb:"] : [])]
  const tmdbNumbering = config.numbering === "tmdb"
  return {
    id: "com.eibyx.jkanimenuvio" + (tmdbNumbering ? ".tmdb" : ""),
    version: pkg.version,
    name: "JKAnimeNuvio" + (tmdbNumbering ? " (TMDB)" : ""),
    description: "Streams de anime en español desde JKAnime (MP4/HLS directos) para Nuvio y Stremio. " +
      "Solo streams: usa tu addon de metadatos habitual (Cinemeta, TMDB, Kitsu). No afiliado a JKAnime.",
    resources: [{ name: "stream", types: TYPES, idPrefixes }],
    types: TYPES,
    idPrefixes,
    catalogs: [],
    behaviorHints: { configurable: false, configurationRequired: false, adult: false, p2p: false },
  }
}
