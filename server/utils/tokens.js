const jwt = require("jsonwebtoken");
const crypto = require("crypto");

// Reuse the existing JWT_SECRET for ACCESS tokens so tokens issued before Phase 2.1
// keep verifying (graceful — no forced logout). Refresh tokens are opaque random
// strings stored only as a SHA-256 hash in the Session collection.
const ACCESS_SECRET = process.env.JWT_SECRET;
const ACCESS_TTL = process.env.ACCESS_TTL || "15m";
const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TTL_DAYS || 30);
const REFRESH_TTL_MS = REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000;

const isProd = process.env.NODE_ENV === "production";
// Same-origin in dev → SameSite=Lax works; Secure only in production (HTTPS).
const baseCookie = { httpOnly: true, sameSite: "lax", secure: isProd, path: "/" };

function signAccess(user, opts = {}) {
  // Customers: short-lived access token (cookie-refreshed). Admin: short TTL (Phase 2.5
  // hardening, default 45m) — full admin tokens carry mfa:true (minted only after MFA).
  const ttl = user.role === "admin" ? (process.env.ADMIN_ACCESS_TTL || "45m") : ACCESS_TTL;
  return jwt.sign(
    { id: user._id, role: user.role, ver: user.tokenVersion || 0, scope: "full", mfa: !!opts.mfa },
    ACCESS_SECRET,
    { expiresIn: ttl }
  );
}

// Short-lived SCOPED tokens for the admin MFA flow. scope ∈ {"admin_enroll","mfa_challenge"}.
// These are NOT full sessions — `protect` rejects them, so they can't reach admin APIs.
function signScoped(user, scope, ttl) {
  return jwt.sign({ id: user._id, role: user.role, ver: user.tokenVersion || 0, scope }, ACCESS_SECRET, { expiresIn: ttl });
}

function verifyAccess(token) {
  return jwt.verify(token, ACCESS_SECRET); // throws on invalid/expired
}

function newRefreshToken() {
  return crypto.randomBytes(48).toString("hex");
}

function hashToken(raw) {
  return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

const REFRESH_COOKIE = "ftk_refresh";
function setRefreshCookie(res, raw) {
  res.cookie(REFRESH_COOKIE, raw, Object.assign({}, baseCookie, { maxAge: REFRESH_TTL_MS }));
}
function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, baseCookie);
}

module.exports = {
  signAccess, signScoped, verifyAccess, newRefreshToken, hashToken,
  setRefreshCookie, clearRefreshCookie, REFRESH_COOKIE, REFRESH_TTL_MS,
  baseCookie, isProd, ACCESS_TTL,
};
