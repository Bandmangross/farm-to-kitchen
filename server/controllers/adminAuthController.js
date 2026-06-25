const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Session = require("../models/Session");
const { normalizeEmail } = require("../utils/email");
const { recordDevice, getOrIssueDeviceId } = require("../utils/device");
const { writeAuthAudit } = require("../utils/audit");
const { encrypt, decrypt, genSecret, otpauth, verify } = require("../utils/totp");
const recovery = require("../utils/recoveryCodes");
const {
  signAccess, signScoped, newRefreshToken, hashToken, setRefreshCookie, REFRESH_TTL_MS,
} = require("../utils/tokens");

const mfaOn = () => process.env.ENABLE_ADMIN_MFA === "true";
const MFA_MAX = Number(process.env.ADMIN_MFA_MAX_ATTEMPTS || 5);
const MFA_LOCK_MS = Number(process.env.ADMIN_MFA_LOCK_MS || 15 * 60 * 1000);
const ENROLL_TTL = process.env.ADMIN_ENROLL_TTL || "15m";
const CHALLENGE_TTL = process.env.ADMIN_CHALLENGE_TTL || "5m";

function pubAdmin(u) { return { id: u._id, fullName: u.fullName, email: u.email, role: u.role, mfaEnabled: u.mfaEnabled }; }

// Mint a FULL admin session (token carries mfa:true) + refresh cookie + device record.
async function startAdminSession(user, req, res) {
  const deviceId = getOrIssueDeviceId(req, res);
  const device = await recordDevice(user._id, deviceId, req);
  const raw = newRefreshToken();
  await Session.create({
    user: user._id, device: device ? device._id : null, refreshTokenHash: hashToken(raw),
    ipAddress: req.ip, userAgent: req.headers["user-agent"] || "", expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
  });
  setRefreshCookie(res, raw);
  return signAccess(user, { mfa: true });
}

// POST /api/admin/login { email, password }
exports.adminLogin = async (req, res, next) => {
  try {
    const emailNorm = normalizeEmail(req.body.email || "");
    const user = await User.findOne({ emailNormalized: emailNorm }).select("+password");
    if (!user || user.role !== "admin" || !(await user.comparePassword(req.body.password || ""))) {
      await writeAuthAudit({ user: user ? user._id : null, email: emailNorm, event: "admin_login_failed", success: false, req, metadata: { reason: "bad_credentials" } });
      return res.status(401).json({ message: "Invalid email or password" });
    }
    if (["suspended", "deleted", "locked"].includes(user.accountStatus)) {
      return res.status(403).json({ message: "This admin account is " + user.accountStatus + "." });
    }

    if (!mfaOn()) {
      // Dormant/rollback: password-only admin login.
      const token = await startAdminSession(user, req, res);
      await writeAuthAudit({ user: user._id, email: user.email, event: "admin_login", success: true, req, metadata: { mfa: false } });
      return res.json({ token, user: pubAdmin(user) });
    }
    if (!user.mfaEnabled) {
      // Forced first-login enrollment — restricted token (MFA setup/enable only).
      return res.json({ enrollmentRequired: true, enrollToken: signScoped(user, "admin_enroll", ENROLL_TTL), user: pubAdmin(user) });
    }
    return res.json({ mfaRequired: true, mfaToken: signScoped(user, "mfa_challenge", CHALLENGE_TTL) });
  } catch (err) { next(err); }
};

// POST /api/admin/login/mfa { mfaToken, code }  (code = TOTP or recovery code)
exports.adminLoginMfa = async (req, res, next) => {
  try {
    let decoded;
    try { decoded = jwt.verify(req.body.mfaToken, process.env.JWT_SECRET); }
    catch (_) { return res.status(401).json({ message: "Your MFA session expired. Please sign in again." }); }
    if (decoded.scope !== "mfa_challenge") return res.status(401).json({ message: "Invalid MFA session." });

    const user = await User.findById(decoded.id).select("+mfaSecret +recoveryCodes");
    if (!user || user.role !== "admin" || !user.mfaEnabled) return res.status(401).json({ message: "Invalid MFA session." });
    if (user.mfaLockUntil && user.mfaLockUntil > new Date()) {
      const mins = Math.ceil((user.mfaLockUntil - Date.now()) / 60000);
      return res.status(429).json({ message: "Too many attempts. Try again in " + mins + " min." });
    }

    const code = String(req.body.code || "").trim();
    let ok = false, usedRecovery = false;
    if (user.mfaSecret && verify(code, decrypt(user.mfaSecret))) ok = true;
    else {
      const rc = await recovery.match(code, user.recoveryCodes);
      if (rc) { ok = true; usedRecovery = true; rc.usedAt = new Date(); user.markModified("recoveryCodes"); }
    }

    if (!ok) {
      user.mfaFailedAttempts = (user.mfaFailedAttempts || 0) + 1;
      if (user.mfaFailedAttempts >= MFA_MAX) { user.mfaLockUntil = new Date(Date.now() + MFA_LOCK_MS); user.mfaFailedAttempts = 0; }
      await user.save();
      await writeAuthAudit({ user: user._id, email: user.email, event: "admin_mfa_challenge_failed", success: false, req });
      return res.status(401).json({ message: "Invalid code." });
    }

    user.mfaFailedAttempts = 0; user.mfaLockUntil = null; user.lastLoginAt = new Date(); user.lastLoginIp = req.ip;
    await user.save();
    if (usedRecovery) await writeAuthAudit({ user: user._id, email: user.email, event: "admin_recovery_used", success: true, req });
    const token = await startAdminSession(user, req, res);
    await writeAuthAudit({ user: user._id, email: user.email, event: "admin_login", success: true, req, metadata: { mfa: true, recovery: usedRecovery } });
    return res.json({ token, user: pubAdmin(user) });
  } catch (err) { next(err); }
};

// POST /api/admin/mfa/setup { password }   (enroll OR full admin token; re-auth password)
exports.mfaSetup = async (req, res, next) => {
  try {
    if (!mfaOn()) return res.status(404).json({ message: "Admin MFA is not enabled." });
    const user = req.user; // loaded with +password by adminEnroll
    if (!(await user.comparePassword(req.body.password || ""))) return res.status(401).json({ code: "INVALID_PASSWORD", message: "Your current password is incorrect." });
    const secret = genSecret();
    user.mfaPendingSecret = encrypt(secret);
    await user.save();
    await writeAuthAudit({ user: user._id, email: user.email, event: "admin_mfa_setup", success: true, req });
    // Secret/QR returned to the client ONCE; never logged.
    return res.json({ secret, otpauthUrl: otpauth(user.email, secret) });
  } catch (err) { next(err); }
};

// POST /api/admin/mfa/enable { password, code }
exports.mfaEnable = async (req, res, next) => {
  try {
    if (!mfaOn()) return res.status(404).json({ message: "Admin MFA is not enabled." });
    const user = req.user; // +password +mfaPendingSecret
    if (!(await user.comparePassword(req.body.password || ""))) return res.status(401).json({ code: "INVALID_PASSWORD", message: "Your current password is incorrect." });
    if (!user.mfaPendingSecret) return res.status(400).json({ message: "Start MFA setup first." });
    if (!verify(req.body.code, decrypt(user.mfaPendingSecret))) return res.status(400).json({ code: "INVALID_CODE", message: "That code is incorrect. Please try again." });

    const codes = recovery.gen(10);
    user.mfaSecret = user.mfaPendingSecret;
    user.mfaPendingSecret = "";
    user.mfaEnabled = true;
    user.mfaEnrolledAt = new Date();
    user.recoveryCodes = await recovery.hashAll(codes);
    user.tokenVersion = (user.tokenVersion || 0) + 1; // invalidate the enroll token → force a real MFA login
    await user.save();
    await writeAuthAudit({ user: user._id, email: user.email, event: "admin_mfa_enabled", success: true, req });
    return res.json({ message: "MFA enabled. Save these recovery codes — they are shown only once.", recoveryCodes: codes });
  } catch (err) { next(err); }
};

// POST /api/admin/mfa/disable { password, code }   (current password + valid TOTP)
exports.mfaDisable = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select("+password +mfaSecret +recoveryCodes");
    if (!user.mfaEnabled) return res.status(400).json({ message: "MFA is not enabled." });
    if (!(await user.comparePassword(req.body.password || ""))) return res.status(401).json({ code: "INVALID_PASSWORD", message: "Your current password is incorrect." });
    if (!verify(req.body.code, decrypt(user.mfaSecret))) return res.status(400).json({ code: "INVALID_CODE", message: "A valid authenticator code is required to disable MFA." });
    user.mfaEnabled = false; user.mfaSecret = ""; user.mfaPendingSecret = ""; user.recoveryCodes = []; user.mfaEnrolledAt = null;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    await writeAuthAudit({ user: user._id, email: user.email, event: "admin_mfa_disabled", success: true, req });
    return res.json({ message: "MFA disabled." });
  } catch (err) { next(err); }
};

// POST /api/admin/mfa/recovery/regenerate { password, code }
exports.recoveryRegenerate = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select("+password +mfaSecret +recoveryCodes");
    if (!user.mfaEnabled) return res.status(400).json({ message: "MFA is not enabled." });
    if (!(await user.comparePassword(req.body.password || ""))) return res.status(401).json({ code: "INVALID_PASSWORD", message: "Your current password is incorrect." });
    if (!verify(req.body.code, decrypt(user.mfaSecret))) return res.status(400).json({ code: "INVALID_CODE", message: "A valid authenticator code is required." });
    const codes = recovery.gen(10);
    user.recoveryCodes = await recovery.hashAll(codes);
    await user.save();
    await writeAuthAudit({ user: user._id, email: user.email, event: "admin_recovery_regenerated", success: true, req });
    return res.json({ message: "New recovery codes generated. Previous codes are now invalid.", recoveryCodes: codes });
  } catch (err) { next(err); }
};
