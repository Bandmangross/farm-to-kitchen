// Must run AFTER `protect`. Allows only admin users through, and (Phase 2.5) enforces
// that an MFA-enrolled admin's token was minted AFTER completing MFA — an enrolled
// admin can never reach admin APIs without MFA.
module.exports = function admin(req, res, next) {
  if (!req.user || req.user.role !== "admin") return res.status(403).json({ message: "Admin access required" });
  const mfaEnforced = process.env.ENABLE_ADMIN_MFA === "true";
  if (mfaEnforced && req.user.mfaEnabled && !(req.auth && req.auth.mfa)) {
    return res.status(403).json({ message: "MFA required for admin access", code: "MFA_REQUIRED" });
  }
  next();
};
