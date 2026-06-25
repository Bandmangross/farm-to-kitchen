const VerificationCode = require("../models/VerificationCode");
const User = require("../models/User");
const { normalizeEmail } = require("../utils/email");
const { issueVerification, verificationEnabled, sha } = require("../utils/emailVerify");
const { writeAuthAudit } = require("../utils/audit");

const devEcho = () => process.env.EMAIL_DEV_ECHO === "true";

async function auditFail(req, code, userId, email, meta) {
  await writeAuthAudit({ user: userId || null, email: email || "", event: "email_verify_failed", success: false, req, metadata: meta });
}
async function auditExpired(req, doc, email, method) {
  await writeAuthAudit({ user: (doc && doc.user) || null, email: email || "", event: "email_expired", success: false, req, metadata: { method } });
}

// POST /api/auth/email/resend  — generic response (no user enumeration).
exports.resend = async (req, res) => {
  const generic = { message: "If your email needs verification, we've sent a new link and code." };
  try {
    if (!verificationEnabled()) return res.json(generic);
    const norm = req.user ? req.user.emailNormalized : normalizeEmail(req.body.email || "");
    const user = req.user || (norm ? await User.findOne({ emailNormalized: norm }) : null);
    if (!user || user.emailVerified || ["deleted", "suspended"].includes(user.accountStatus)) return res.json(generic);

    const out = await issueVerification(user, req, { resend: true });
    const resp = Object.assign({}, generic);
    if (devEcho()) { resp.devLink = out.link; resp.devCode = out.code; }
    return res.json(resp);
  } catch (e) {
    if (e.code === "COOLDOWN") return res.status(429).json({ message: e.message, retryAfter: e.wait });
    if (e.code === "CAP") return res.status(429).json({ message: e.message });
    console.warn("[email.resend]", e.message);
    return res.json(generic); // never leak details
  }
};

// POST /api/auth/email/verify   body: { token }  OR  { email, code }
// Result codes: VERIFIED | EXPIRED | ALREADY_USED | INVALID_TOKEN
exports.verify = async (req, res) => {
  try {
    const { token, email, code } = req.body || {};
    let doc = null;
    let method = null;

    if (token) {
      method = "link";
      doc = await VerificationCode.findOne({ purpose: "email_verify", tokenHash: sha(token) });
      if (!doc) { await auditFail(req, "INVALID_TOKEN", null, email, { method, reason: "invalid" }); return res.status(400).json({ code: "INVALID_TOKEN", message: "This verification link is invalid." }); }
    } else if (email && code) {
      method = "code";
      const user = await User.findOne({ emailNormalized: normalizeEmail(email) });
      const active = user ? await VerificationCode.findOne({ user: user._id, purpose: "email_verify", consumedAt: null }).sort({ createdAt: -1 }) : null;
      if (!active) { await auditFail(req, "INVALID_TOKEN", user && user._id, email, { method, reason: "invalid" }); return res.status(400).json({ code: "INVALID_TOKEN", message: "This verification code is invalid." }); }
      if (active.expiresAt < new Date()) { await auditExpired(req, active, email, method); return res.status(410).json({ code: "EXPIRED", message: "This verification has expired. Please request a new one." }); }
      if (active.attempts >= active.maxAttempts) { await auditFail(req, "INVALID_TOKEN", active.user, email, { method, reason: "too_many" }); return res.status(400).json({ code: "INVALID_TOKEN", message: "Too many incorrect attempts. Please request a new code." }); }
      if (active.codeHash !== sha(code)) {
        active.attempts += 1; await active.save();
        await auditFail(req, "INVALID_TOKEN", active.user, email, { method, reason: "bad_code" });
        return res.status(400).json({ code: "INVALID_TOKEN", message: "Incorrect code. Please try again." });
      }
      doc = active;
    } else {
      return res.status(400).json({ code: "INVALID_TOKEN", message: "Provide a verification token or your email + code." });
    }

    // Shared checks on the resolved doc (covers the link path).
    if (doc.consumedAt) { await auditFail(req, "ALREADY_USED", doc.user, email, { method, reason: "used" }); return res.status(409).json({ code: "ALREADY_USED", message: "This verification has already been used." }); }
    if (doc.expiresAt < new Date()) { await auditExpired(req, doc, email, method); return res.status(410).json({ code: "EXPIRED", message: "This verification has expired. Please request a new one." }); }

    const user = await User.findById(doc.user);
    if (!user || ["deleted", "suspended"].includes(user.accountStatus)) {
      return res.status(400).json({ code: "INVALID_TOKEN", message: "This account is not eligible for verification." });
    }

    // Success → consume + activate.
    doc.consumedAt = new Date(); await doc.save();
    user.emailVerified = true;
    user.verifiedAt = new Date();
    user.verificationMethod = method;
    user.verificationIp = req.ip;
    if (user.accountStatus === "pending_verification") user.accountStatus = "active";
    await user.save();
    await writeAuthAudit({ user: user._id, email: user.email, event: "email_verified", success: true, req, metadata: { method } });

    return res.json({
      code: "VERIFIED",
      message: "Your email has been verified.",
      user: { id: user._id, email: user.email, emailVerified: true, accountStatus: user.accountStatus },
    });
  } catch (e) {
    console.warn("[email.verify]", e.message);
    return res.status(400).json({ code: "INVALID_TOKEN", message: "Verification failed." });
  }
};
