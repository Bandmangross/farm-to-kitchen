const router = require("express").Router();
const ctrl = require("../controllers/authController");
const emailVerify = require("../controllers/emailVerifyController");
const phoneVerify = require("../controllers/phoneVerifyController");
const pwReset = require("../controllers/passwordResetController");
const adminAuth = require("../controllers/adminAuthController");
const adminEnroll = require("../middleware/adminEnroll");
const admin = require("../middleware/admin");
const { protect, optionalAuth } = require("../middleware/auth");
const { authLimiter } = require("../middleware/rateLimit");

router.post("/register", authLimiter, ctrl.register);
router.post("/login", authLimiter, ctrl.login);
router.post("/auth/token/refresh", authLimiter, ctrl.refresh);

// Email verification (Phase 2.2) — per-IP rate limited.
router.post("/auth/email/resend", authLimiter, optionalAuth, emailVerify.resend);
router.post("/auth/email/verify", authLimiter, emailVerify.verify);

// Phone verification (Phase 2.3) — authed + per-IP rate limited.
router.post("/auth/phone/request", authLimiter, protect, phoneVerify.request);
router.post("/auth/phone/verify", authLimiter, protect, phoneVerify.verify);
router.post("/auth/phone/resend", authLimiter, protect, phoneVerify.resend);

// Password reset & change (Phase 2.4) — per-IP rate limited.
router.post("/auth/password/forgot", authLimiter, pwReset.forgot);
router.post("/auth/password/reset", authLimiter, pwReset.reset);
router.post("/auth/password/change", authLimiter, protect, pwReset.change);

// Admin MFA / hardening (Phase 2.5) — admins authenticate ONLY here.
router.post("/admin/login", authLimiter, adminAuth.adminLogin);
router.post("/admin/login/mfa", authLimiter, adminAuth.adminLoginMfa);
router.post("/admin/mfa/setup", authLimiter, adminEnroll, adminAuth.mfaSetup);
router.post("/admin/mfa/enable", authLimiter, adminEnroll, adminAuth.mfaEnable);
router.post("/admin/mfa/disable", authLimiter, protect, admin, adminAuth.mfaDisable);
router.post("/admin/mfa/recovery/regenerate", authLimiter, protect, admin, adminAuth.recoveryRegenerate);
router.post("/logout", optionalAuth, ctrl.logout);
router.post("/auth/logout-all", protect, ctrl.logoutAll);
router.get("/me", protect, ctrl.me);
router.put("/me", protect, ctrl.updateProfile);
router.get("/me/devices", protect, ctrl.listDevices);
router.delete("/me/devices/:id", protect, ctrl.revokeDevice);
// Session management (Phase 2.6) — customer-facing; flag-gated in the controller.
router.get("/me/sessions", protect, ctrl.listSessions);
router.post("/me/sessions/revoke-all", authLimiter, protect, ctrl.revokeAllSessions);

module.exports = router;
