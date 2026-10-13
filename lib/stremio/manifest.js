const pkg = require("../../package.json")
const tmdb = require("../providers/tmdb")
const tvdb = require("../providers/tvdb")

const TYPES = ["series", "movie", "anime"]
exports.TYPES = TYPES

/** Stream-only manifest: no catalogs, no meta. */
exports.buildManifest = function buildManifest(config = {}) {
  const idPrefixes = ["tt", "kitsu:", "mal:", "anilist:", ...(tmdb.enabled() ? ["tmdb:"] : []), ...(tvdb.enabled() ? ["tvdb:"] : [])]
  // Each configuration gets its own id so it can be installed next to the default one.
  const variant = [config.numbering, config.mapping].filter((v) => v && v !== "auto")
  return {
    id: "com.eibyx.jkanimenuvio" + variant.map((v) => "." + v.replace(/[^a-z0-9]/g, "")).join(""),
    version: pkg.version,
    name: "JKAnimeNuvio" + (variant.length ? ` (${variant.join(", ")})` : ""),
    description: "Streams de anime en español desde JKAnime (MP4/HLS directos) para Nuvio y Stremio. " +
      "Solo streams: identifica el anime con TMDB, TVDB, AniList, Kitsu o Cinemeta y usa tu addon de metadatos habitual. No afiliado a JKAnime.",
    resources: [{ name: "stream", types: TYPES, idPrefixes }],
    types: TYPES,
    idPrefixes,
    catalogs: [],
    behaviorHints: { configurable: false, configurationRequired: false, adult: false, p2p: false },
  }
}
