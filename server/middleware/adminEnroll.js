const jwt = require("jsonwebtoken");
const User = require("../models/User");

// Accepts EITHER a restricted enrollment token (scope "admin_enroll") OR a full admin
// token. Loads the admin with the secrets the MFA setup/enable handlers need. Used ONLY
// for /admin/mfa/setup and /admin/mfa/enable.
module.exports = async function adminEnroll(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.split(" ")[1] : null;
  if (!token) return res.status(401).json({ message: "Not authorized — no token" });

  let d;
  try { d = jwt.verify(token, process.env.JWT_SECRET); }
  catch (_) { return res.status(401).json({ message: "Not authorized — invalid or expired token" }); }
  if (!(d.scope === "admin_enroll" || d.scope === "full")) return res.status(401).json({ message: "Invalid token scope" });

  const user = await User.findById(d.id).select("+password +mfaSecret +mfaPendingSecret +recoveryCodes");
  if (!user || user.role !== "admin") return res.status(403).json({ message: "Admin access required" });
  if ((d.ver || 0) !== (user.tokenVersion || 0)) return res.status(401).json({ message: "Session expired — please sign in again" });

  req.user = user;
  req.auth = { scope: d.scope, mfa: !!d.mfa };
  next();
};
