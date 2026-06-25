const VerificationCode = require("../models/VerificationCode");
const { startVerification } = require("./twilioVerify");
const { writeAuthAudit } = require("./audit");

const COOLDOWN_S = Number(process.env.PHONE_RESEND_COOLDOWN_SEC || 60);
const DAILY_CAP = Number(process.env.PHONE_DAILY_CAP || 5);
const TTL_MS = Number(process.env.PHONE_OTP_TTL_MS || 10 * 60 * 1000); // 10 min
const MAX_ATTEMPTS = Number(process.env.PHONE_CODE_MAX_ATTEMPTS || 5);

const phoneEnabled = () => process.env.ENABLE_PHONE_VERIFICATION === "true";

// Issue (or re-issue) a phone OTP: enforce 60s cooldown + 5/day cap, start the
// provider verification, record metadata, and audit. Throws { code: COOLDOWN|CAP }.
async function issuePhoneOtp(user, phoneE164, country, channel, req, { resend = false } = {}) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent = await VerificationCode.find({
    user: user._id, purpose: "phone_verify", createdAt: { $gte: since },
  }).sort({ createdAt: -1 });

  if (recent.length) {
    const totalSends = recent.reduce((s, r) => s + (r.sendCount || 1), 0);
    if (totalSends >= DAILY_CAP) { const e = new Error("Daily verification limit reached. Please try again tomorrow."); e.code = "CAP"; throw e; }
    if (resend) {
      const elapsed = Date.now() - new Date(recent[0].lastSentAt || recent[0].createdAt).getTime();
      if (elapsed < COOLDOWN_S * 1000) {
        const wait = Math.ceil((COOLDOWN_S * 1000 - elapsed) / 1000);
        const e = new Error("Please wait " + wait + "s before requesting another code."); e.code = "COOLDOWN"; e.wait = wait; throw e;
      }
    }
  }

  await VerificationCode.updateMany(
    { user: user._id, purpose: "phone_verify", consumedAt: null },
    { $set: { consumedAt: new Date() } }
  );

  const started = await startVerification({ phoneE164, channel });
  await VerificationCode.create({
    user: user._id, channel, purpose: "phone_verify",
    codeHash: started.codeHash || "", providerRef: started.providerRef || "", status: started.status || "pending",
    expiresAt: new Date(Date.now() + TTL_MS), maxAttempts: MAX_ATTEMPTS, sendCount: 1, lastSentAt: new Date(), ip: req.ip,
  });
  await writeAuthAudit({ user: user._id, email: user.email, event: resend ? "phone_otp_resent" : "phone_otp_sent", success: true, req, metadata: { channel, country } });

  return { devCode: started.devCode };
}

module.exports = { issuePhoneOtp, phoneEnabled, MAX_ATTEMPTS };
