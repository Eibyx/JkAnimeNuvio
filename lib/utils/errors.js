/**
 * Error codes shared by the scraper, the extractors and the diagnostics.
 * HTTP-level codes (HTTP_404, HTTP_419, HTTP_429, HTTP_5XX, TIMEOUT, BLOCKED,
 * UNSAFE_URL, TOO_LARGE, ...) come from lib/utils/http.js.
 */
const CODES = new Set([
  "HTTP_404", "HTTP_419", "HTTP_429", "HTTP_5XX", "TIMEOUT", "BLOCKED", "UNSAFE_URL", "TOO_LARGE",
  "TOO_MANY_REDIRECTS", "NETWORK_ERROR",
  "PARSER_CHANGED",     // the page loaded but its structure is not the expected one
  "UNSUPPORTED_FORMAT", // the host answered in a format this extractor does not implement
  "INVALID_MEDIA_URL",  // something was extracted, but it is not a direct MP4/HLS URL
  "NO_MEDIA",           // the page is valid and simply lists no playable source
  "EXTRACTOR_ERROR",    // anything else inside an extractor
  "EPISODE_NOT_FOUND",
])

class AppError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "AppError"
    this.code = code
  }
}

/** Stable code for any error thrown while scraping or extracting. */
function errorCode(err) {
  const code = err?.code
  if (typeof code === "string" && (CODES.has(code) || /^HTTP_\d{3}$/.test(code))) return code
  if (/timed out|timeout|aborted/i.test(err?.message || "")) return "TIMEOUT"
  return "EXTRACTOR_ERROR"
}

module.exports = { AppError, errorCode, CODES }
