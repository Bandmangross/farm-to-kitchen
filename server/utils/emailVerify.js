const crypto = require("crypto");
const VerificationCode = require("../models/VerificationCode");
const { sendVerificationEmail } = require("./email");
const { writeAuthAudit } = require("./audit");

const TTL_H = Number(process.env.EMAIL_VERIFY_TTL_HOURS || 24);
const COOLDOWN_S = Number(process.env.EMAIL_RESEND_COOLDOWN_SEC || 60);
const DAILY_CAP = Number(process.env.EMAIL_DAILY_CAP || 5);
const MAX_ATTEMPTS = Number(process.env.EMAIL_CODE_MAX_ATTEMPTS || 5);

const verificationEnabled = () => process.env.ENABLE_EMAIL_VERIFICATION === "true";

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const newToken = () => crypto.randomBytes(32).toString("hex");
const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, "0");

// Issue (or re-issue) an email_verify record, send the email, and audit.
// Enforces 60s cooldown + 5/day cap on RESENDS. Throws { code: "COOLDOWN"|"CAP" }.
async function issueVerification(user, req, { resend = false } = {}) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent = await VerificationCode.find({
    user: user._id, purpose: "email_verify", createdAt: { $gte: since },
  }).sort({ createdAt: -1 });

  if (recent.length) {
    const totalSends = recent.reduce((s, r) => s + (r.sendCount || 1), 0);
    if (totalSends >= DAILY_CAP) { const e = new Error("Daily verification email limit reached. Please try again tomorrow."); e.code = "CAP"; throw e; }
    if (resend) {
      const elapsed = Date.now() - new Date(recent[0].lastSentAt || recent[0].createdAt).getTime();
      if (elapsed < COOLDOWN_S * 1000) {
        const wait = Math.ceil((COOLDOWN_S * 1000 - elapsed) / 1000);
        const e = new Error("Please wait " + wait + "s before requesting another email."); e.code = "COOLDOWN"; e.wait = wait; throw e;
      }
    }
  }

  // Invalidate previous unconsumed records (single active verification at a time).
  await VerificationCode.updateMany(
    { user: user._id, purpose: "email_verify", consumedAt: null },
    { $set: { consumedAt: new Date() } }
  );

  const token = newToken();
  const code = newCode();
  await VerificationCode.create({
    user: user._id, channel: "email", purpose: "email_verify",
    codeHash: sha(code), tokenHash: sha(token),
    expiresAt: new Date(Date.now() + TTL_H * 60 * 60 * 1000),
    maxAttempts: MAX_ATTEMPTS, sendCount: 1, lastSentAt: new Date(), ip: req.ip,
  });

  const base = process.env.APP_URL || "http://localhost:5050";
  const link = base + "/verify-email.html?token=" + token;
  await sendVerificationEmail({ to: user.emailOriginal || user.email, link, code, lang: user.language || "en" });
  await writeAuthAudit({ user: user._id, email: user.email, event: resend ? "email_resent" : "email_sent", success: true, req });

  return { token, code, link };
}

module.exports = { issueVerification, verificationEnabled, sha, MAX_ATTEMPTS };
