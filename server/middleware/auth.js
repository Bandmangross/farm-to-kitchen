const { verifyAccess } = require("../utils/tokens");
const User = require("../models/User");

const BLOCKED = ["suspended", "locked", "deleted"];

function bearer(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.split(" ")[1] : null;
}

// Resolve a verified access token → live user, enforcing account status + tokenVersion.
// Returns { user } or { error: { status, message } }.
async function resolve(token) {
  let decoded;
  try { decoded = verifyAccess(token); }
  catch (_) { return { error: { status: 401, message: "Not authorized — invalid or expired token" } }; }

  // Only FULL session tokens are accepted here. Scoped admin-MFA tokens
  // (admin_enroll / mfa_challenge) must NOT grant access to protected routes.
  const scope = decoded.scope || "full";
  if (scope !== "full") return { error: { status: 401, message: "Not authorized — this token can't access this resource" } };

  const user = await User.findById(decoded.id);
  if (!user) return { error: { status: 401, message: "User no longer exists" } };

  // Graceful: tokens issued before Phase 2.1 carry no `ver` → treated as 0.
  if ((decoded.ver || 0) !== (user.tokenVersion || 0)) {
    return { error: { status: 401, message: "Session expired — please sign in again" } };
  }
  if (BLOCKED.includes(user.accountStatus)) {
    return { error: { status: 403, message: "This account is " + user.accountStatus + "." } };
  }
  return { user, auth: { scope, mfa: !!decoded.mfa } };
}

// Strict: blocks when the token is missing/invalid or the account is blocked.
async function protect(req, res, next) {
  const token = bearer(req);
  if (!token) return res.status(401).json({ message: "Not authorized — no token" });
  const { user, auth, error } = await resolve(token);
  if (error) return res.status(error.status).json({ message: error.message });
  req.user = user;
  req.auth = auth;
  next();
}

// Optional: attaches req.user when a valid, non-blocked token is present; never blocks.
async function optionalAuth(req, res, next) {
  const token = bearer(req);
  if (token) {
    const { user } = await resolve(token);
    if (user) req.user = user;
  }
  next();
}

module.exports = { protect, optionalAuth };
