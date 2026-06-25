const crypto = require("crypto");
const VerificationCode = require("../models/VerificationCode");
const User = require("../models/User");
const Session = require("../models/Session");
const { normalizeEmail, sendResetEmail, sendPasswordChangedEmail } = require("../utils/email");
const { validateNewPassword, applyNewPassword } = require("../utils/passwordPolicy");
const { writeAuthAudit } = require("../utils/audit");
const {
  signAccess, newRefreshToken, hashToken, setRefreshCookie, clearRefreshCookie, REFRESH_COOKIE, REFRESH_TTL_MS,
} = require("../utils/tokens");

const LINK_TTL_MS = Number(process.env.RESET_LINK_TTL_MIN || 30) * 60 * 1000;
const CODE_TTL_MS = Number(process.env.RESET_CODE_TTL_MIN || 10) * 60 * 1000;
const COOLDOWN_S = Number(process.env.RESET_COOLDOWN_SEC || 60);
const DAILY_CAP = Number(process.env.RESET_DAILY_CAP || 5);
const MAX_ATTEMPTS = 5;

const enabled = () => process.env.ENABLE_PASSWORD_RESET === "true";
const devEcho = () => process.env.PWRESET_DEV_ECHO === "true";

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const newToken = () => crypto.randomBytes(32).toString("hex");
const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, "0");

async function issueReset(user, req) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent = await VerificationCode.find({ user: user._id, purpose: "password_reset", createdAt: { $gte: since } }).sort({ createdAt: -1 });
  if (recent.length) {
    const total = recent.reduce((s, r) => s + (r.sendCount || 1), 0);
    if (total >= DAILY_CAP) { const e = new Error("Daily reset limit reached. Please try again tomorrow."); e.code = "CAP"; throw e; }
    const elapsed = Date.now() - new Date(recent[0].lastSentAt || recent[0].createdAt).getTime();
    if (elapsed < COOLDOWN_S * 1000) { const w = Math.ceil((COOLDOWN_S * 1000 - elapsed) / 1000); const e = new Error("Please wait " + w + "s before requesting another reset."); e.code = "COOLDOWN"; e.wait = w; throw e; }
  }
  await VerificationCode.updateMany({ user: user._id, purpose: "password_reset", consumedAt: null }, { $set: { consumedAt: new Date() } });

  const token = newToken(), code = newCode();
  const now = Date.now();
  await VerificationCode.create({
    user: user._id, channel: "email", purpose: "password_reset",
    tokenHash: sha(token), codeHash: sha(code),
    linkExpiresAt: new Date(now + LINK_TTL_MS), codeExpiresAt: new Date(now + CODE_TTL_MS),
    expiresAt: new Date(now + LINK_TTL_MS), // doc TTL = the later (link)
    maxAttempts: MAX_ATTEMPTS, sendCount: 1, lastSentAt: new Date(), ip: req.ip,
  });
  const link = (process.env.APP_URL || "http://localhost:5050") + "/reset-password.html?token=" + token;
  await sendResetEmail({ to: user.emailOriginal || user.email, link, code, lang: user.language || "en" });
  await writeAuthAudit({ user: user._id, email: user.email, event: "password_reset", success: true, req, metadata: { stage: "requested" } });
  return { token, code, link };
}

// POST /api/auth/password/forgot  { email }
exports.forgot = async (req, res) => {
  const generic = { message: "If an account exists for that email, a password reset has been sent." };
  try {
    if (!enabled()) return res.json(generic);
    const norm = normalizeEmail(req.body.email || "");
    const user = norm ? await User.findOne({ emailNormalized: norm }) : null;
    // Admin excluded from self-service (Decision 11); suspended/deleted excluded; unknown → generic.
    if (!user || user.role === "admin" || ["suspended", "deleted"].includes(user.accountStatus)) return res.json(generic);
    const out = await issueReset(user, req);
    const resp = Object.assign({}, generic);
    if (devEcho()) { resp.devToken = out.token; resp.devCode = out.code; }
    return res.json(resp);
  } catch (e) {
    if (e.code === "COOLDOWN") return res.status(429).json({ message: e.message, retryAfter: e.wait });
    if (e.code === "CAP") return res.status(429).json({ message: e.message });
    console.warn("[pwreset.forgot]", e.message);
    return res.json(generic);
  }
};

// POST /api/auth/password/reset  { token | (email+code), newPassword }
exports.reset = async (req, res) => {
  if (!enabled()) return res.status(404).json({ message: "Password reset is not enabled." });
  try {
    const { token, email, code, newPassword } = req.body || {};
    let doc = null, method = null, user = null;

    if (token) {
      method = "link";
      doc = await VerificationCode.findOne({ purpose: "password_reset", tokenHash: sha(token) });
      if (!doc) return res.status(400).json({ code: "INVALID_TOKEN", message: "This reset link is invalid." });
      if (doc.consumedAt) return res.status(409).json({ code: "ALREADY_USED", message: "This reset link has already been used." });
      if (doc.linkExpiresAt < new Date()) { await auditFail(req, doc.user, "link_expired"); return res.status(410).json({ code: "EXPIRED", message: "This reset link has expired. Please request a new one." }); }
      user = await User.findById(doc.user).select("+password +passwordHistory");
    } else if (email && code) {
      method = "code";
      user = await User.findOne({ emailNormalized: normalizeEmail(email) }).select("+password +passwordHistory");
      doc = user ? await VerificationCode.findOne({ user: user._id, purpose: "password_reset", consumedAt: null }).sort({ createdAt: -1 }) : null;
      if (!doc) return res.status(400).json({ code: "INVALID_TOKEN", message: "This reset code is invalid." });
      if (doc.codeExpiresAt < new Date()) { await auditFail(req, doc.user, "code_expired"); return res.status(410).json({ code: "EXPIRED", message: "This reset code has expired. Please request a new one." }); }
      if (doc.attempts >= doc.maxAttempts) { await auditFail(req, doc.user, "too_many"); return res.status(400).json({ code: "INVALID_TOKEN", message: "Too many attempts. Please request a new reset." }); }
      if (doc.codeHash !== sha(code)) { doc.attempts += 1; await doc.save(); await auditFail(req, doc.user, "bad_code"); return res.status(400).json({ code: "INVALID_TOKEN", message: "Incorrect code. Please try again." }); }
    } else {
      return res.status(400).json({ code: "INVALID_TOKEN", message: "Provide a reset token, or your email and code." });
    }

    if (!user || user.role === "admin" || ["suspended", "deleted"].includes(user.accountStatus)) {
      return res.status(400).json({ code: "INVALID_TOKEN", message: "This account is not eligible for reset." });
    }

    const check = await validateNewPassword(newPassword, user);
    if (!check.ok) return res.status(400).json({ code: check.code, message: check.message });

    doc.consumedAt = new Date(); await doc.save();
    applyNewPassword(user, newPassword);
    user.failedLoginAttempts = 0; user.lockUntil = null;
    user.tokenVersion = (user.tokenVersion || 0) + 1; // revoke ALL access tokens
    await user.save();
    await Session.updateMany({ user: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } }); // revoke ALL refresh
    clearRefreshCookie(res);

    await writeAuthAudit({ user: user._id, email: user.email, event: "password_reset", success: true, req, metadata: { stage: "completed", method } });
    await sendPasswordChangedEmail({ to: user.emailOriginal || user.email, lang: user.language || "en", reason: "reset" });
    return res.json({ code: "OK", message: "Your password has been reset. Please sign in with your new password." });
  } catch (e) {
    console.warn("[pwreset.reset]", e.message);
    return res.status(400).json({ code: "INVALID_TOKEN", message: "Password reset failed." });
  }
};

// POST /api/auth/password/change  { currentPassword, newPassword }  (authed)
exports.change = async (req, res) => {
  if (!enabled()) return res.status(404).json({ message: "Password change is not enabled." });
  try {
    const user = await User.findById(req.user._id).select("+password +passwordHistory");
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ message: "Current and new password are required." });

    if (!(await user.comparePassword(currentPassword))) {
      await writeAuthAudit({ user: user._id, email: user.email, event: "password_change", success: false, req, metadata: { reason: "bad_current" } });
      return res.status(401).json({ code: "INVALID_CURRENT", message: "Your current password is incorrect." });
    }
    const check = await validateNewPassword(newPassword, user);
    if (!check.ok) return res.status(400).json({ code: check.code, message: check.message });

    applyNewPassword(user, newPassword);
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    // Revoke OTHER sessions, keep current (Decision 10): rotate the current session and
    // re-issue an access token bearing the new tokenVersion.
    const raw = req.cookies && req.cookies[REFRESH_COOKIE];
    const currentHash = raw ? hashToken(raw) : null;
    await Session.updateMany(
      { user: user._id, revokedAt: null, ...(currentHash ? { refreshTokenHash: { $ne: currentHash } } : {}) },
      { $set: { revokedAt: new Date() } }
    );
    if (currentHash) {
      await Session.updateMany({ user: user._id, refreshTokenHash: currentHash, revokedAt: null }, { $set: { revokedAt: new Date() } });
      const newRaw = newRefreshToken();
      await Session.create({ user: user._id, refreshTokenHash: hashToken(newRaw), ipAddress: req.ip, userAgent: req.headers["user-agent"] || "", expiresAt: new Date(Date.now() + REFRESH_TTL_MS) });
      setRefreshCookie(res, newRaw);
    }
    const newAccess = signAccess(user, { mfa: !!(req.auth && req.auth.mfa) }); // preserve admin MFA on the rotated token

    await writeAuthAudit({ user: user._id, email: user.email, event: "password_change", success: true, req });
    await sendPasswordChangedEmail({ to: user.emailOriginal || user.email, lang: user.language || "en", reason: "change" });
    return res.json({ code: "OK", message: "Your password has been changed.", token: newAccess });
  } catch (e) {
    console.warn("[pwreset.change]", e.message);
    return res.status(400).json({ message: "Could not change password." });
  }
};

async function auditFail(req, userId, reason) {
  await writeAuthAudit({ user: userId || null, event: "password_reset", success: false, req, metadata: { stage: "failed", reason } });
}
