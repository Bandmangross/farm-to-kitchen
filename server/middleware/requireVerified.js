const { writeAuthAudit } = require("../utils/audit");

// Order-placement gate. BUILT in Phase 2.1, ENABLED in Phase 2.2 (with the
// verification UI) via ENABLE_ORDER_VERIFICATION_GATE=true. While disabled it is a
// pure no-op, so existing guest/customer ordering is unchanged.
module.exports = async function requireVerified(req, res, next) {
  if (process.env.ENABLE_ORDER_VERIFICATION_GATE !== "true") return next();

  const user = req.user;
  if (!user) {
    return res.status(401).json({ message: "Please sign in and verify your account before ordering." });
  }
  if (!(user.emailVerified && user.phoneVerified)) {
    return res.status(403).json({
      message: "Please verify your email and phone number before placing an order.",
      code: "VERIFICATION_REQUIRED",
      emailVerified: user.emailVerified,
      phoneVerified: user.phoneVerified,
    });
  }
  next();
};
