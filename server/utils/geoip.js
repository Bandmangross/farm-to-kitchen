// Phase 2.6 — COARSE geo-IP resolution for login-anomaly detection only.
// City/country granularity, never lat/long or street level. Fully OFFLINE: uses the
// bundled geoip-lite database when present (no external network calls — privacy-safe),
// and degrades gracefully to "Unknown" when the DB is unavailable or the IP is
// private/loopback. Mirrors the dev-fallback pattern used by the email/SMS layers.

let _lib = null;
let _resolved = false;
function lib() {
  if (_resolved) return _lib;
  _resolved = true;
  try {
    _lib = require("geoip-lite");
    console.log("[GeoIP] geoip-lite ready (offline, coarse city/country)");
  } catch (e) {
    _lib = null;
    console.log("[GeoIP] geoip-lite unavailable — coarse location disabled (" + e.message + ")");
  }
  return _lib;
}

// Normalize an IPv4-mapped IPv6 address ("::ffff:1.2.3.4" → "1.2.3.4").
function clean(ip) {
  return String(ip || "").replace(/^::ffff:/i, "").trim();
}

// → { city, country } with coarse values; empty strings when unknown/private/loopback.
function lookup(ip) {
  const ic = clean(ip);
  if (!ic) return { city: "", country: "" };
  const g = lib();
  if (!g) return { city: "", country: "" };
  try {
    const r = g.lookup(ic); // null for private/loopback/unknown ranges
    if (!r) return { city: "", country: "" };
    return { city: r.city || "", country: r.country || "" }; // country = ISO-3166 alpha-2
  } catch (_) {
    return { city: "", country: "" };
  }
}

// Human label for UI/email, e.g. "Lagos, NG" or "Unknown location".
function label(geo) {
  if (!geo) return "Unknown location";
  const parts = [geo.city, geo.country].filter(Boolean);
  return parts.length ? parts.join(", ") : "Unknown location";
}

module.exports = { lookup, label };
