const VerificationCode = require("../models/VerificationCode");
const User = require("../models/User");
const { parsePhone, maskPhone } = require("../utils/phone");
const { lookupRisk, checkVerification } = require("../utils/twilioVerify");
const { issuePhoneOtp, phoneEnabled } = require("../utils/phoneVerify");
const { writeAuthAudit } = require("../utils/audit");

const devEcho = () => process.env.PHONE_DEV_ECHO === "true";

// Data-collection only (no enforcement): rolling daily attempt counter.
function bumpAttempts(user) {
  const now = Date.now();
  if (!user.phoneAttemptsResetAt || now > new Date(user.phoneAttemptsResetAt).getTime()) {
    user.phoneVerificationAttemptsToday = 0;
    user.phoneAttemptsResetAt = new Date(now + 24 * 60 * 60 * 1000);
  }
  user.phoneVerificationAttemptsToday = (user.phoneVerificationAttemptsToday || 0) + 1;
}

async function failAudit(req, user, reason) {
  await writeAuthAudit({ user: user._id, email: user.email, event: "phone_verify_failed", success: false, req, metadata: { reason } });
}

// POST /api/auth/phone/request  { phone, channel? }
exports.request = async (req, res) => {
  if (!phoneEnabled()) return res.status(404).json({ message: "Phone verification is not enabled." });
  try {
    const user = req.user;
    const parsed = parsePhone(req.body.phone);
    if (!parsed.valid) return res.status(400).json({ code: "INVALID_PHONE", message: "Please enter a valid phone number including country code." });
    const channel = ["sms", "whatsapp", "voice"].includes(req.body.channel) ? req.body.channel : "sms";

    // One verified number per account (uniqueness).
    const other = await User.findOne({ phoneE164: parsed.e164, _id: { $ne: user._id } });
    if (other) return res.status(409).json({ code: "NUMBER_IN_USE", message: "This phone number is already verified on another account." });
    if (user.phoneVerified && user.phoneE164 === parsed.e164) return res.status(200).json({ code: "ALREADY_VERIFIED", message: "This number is already verified." });

    // Risk (VoIP/disposable → allow with friction + log). Fraud fields are data-only.
    const risk = await lookupRisk(parsed.e164);
    bumpAttempts(user);
    user.phoneRiskScore = risk.score;
    user.phoneRiskFlag = !!risk.voip;
    user.pendingPhone = parsed.e164;
    user.pendingPhoneCountry = parsed.country;
    await user.save();
    if (risk.voip) await writeAuthAudit({ user: user._id, email: user.email, event: "phone_risk_flagged", success: true, req, metadata: { lineType: risk.lineType, score: risk.score } });

    const out = await issuePhoneOtp(user, parsed.e164, parsed.country, channel, req);
    const resp = { message: "Verification code sent.", to: maskPhone(parsed.e164), channel };
    if (risk.voip) { resp.code = "RISK_FRICTION"; resp.friction = true; } // non-blocking signal for optional CAPTCHA
    if (devEcho()) resp.devCode = out.devCode;
    return res.json(resp);
  } catch (e) {
    if (e.code === "COOLDOWN") return res.status(429).json({ message: e.message, retryAfter: e.wait });
    if (e.code === "CAP") return res.status(429).json({ message: e.message });
    console.warn("[phone.request]", e.message);
    return res.status(500).json({ message: "Could not send verification code." });
  }
};

// POST /api/auth/phone/verify  { code }
exports.verify = async (req, res) => {
  if (!phoneEnabled()) return res.status(404).json({ message: "Phone verification is not enabled." });
  try {
    const user = req.user;
    const code = req.body.code;
    const target = user.pendingPhone || user.phoneE164;
    if (!target || !code) return res.status(400).json({ code: "INVALID_CODE", message: "Provide the verification code." });

    bumpAttempts(user); await user.save();

    const active = await VerificationCode.findOne({ user: user._id, purpose: "phone_verify", consumedAt: null }).sort({ createdAt: -1 });
    if (!active) { await failAudit(req, user, "invalid"); return res.status(400).json({ code: "INVALID_CODE", message: "This code is invalid. Please request a new one." }); }
    if (active.expiresAt < new Date()) { await writeAuthAudit({ user: user._id, email: user.email, event: "phone_expired", success: false, req }); return res.status(410).json({ code: "EXPIRED", message: "This code has expired. Please request a new one." }); }
    if (active.attempts >= active.maxAttempts) { await failAudit(req, user, "too_many"); return res.status(400).json({ code: "INVALID_CODE", message: "Too many incorrect attempts. Please request a new code." }); }

    const result = await checkVerification({ phoneE164: target, code, doc: active });
    if (!result.ok) {
      active.attempts += 1; await active.save();
      await failAudit(req, user, "bad_code");
      return res.status(400).json({ code: "INVALID_CODE", message: "Incorrect code. Please try again." });
    }

    // Success → consume + persist (replacement-aware).
    active.consumedAt = new Date(); active.status = "approved"; await active.save();
    const changed = !!(user.phoneVerified && user.phoneE164 && user.phoneE164 !== target);
    const oldMasked = user.phoneE164 ? maskPhone(user.phoneE164) : null;
    const now = new Date();
    try {
      user.phoneE164 = target;
      user.phoneCountryCode = parsePhone(target).countryCallingCode || user.phoneCountryCode;
      user.phoneVerificationCountry = user.pendingPhoneCountry || user.phoneVerificationCountry;
      user.phoneVerified = true;
      user.phoneVerifiedAt = now;
      user.phoneLastVerifiedAt = now;
      user.phoneVerificationMethod = active.channel;
      user.phoneVerificationIp = req.ip;
      user.pendingPhone = "";
      user.pendingPhoneCountry = "";
      await user.save();
    } catch (err) {
      if (err.code === 11000) return res.status(409).json({ code: "NUMBER_IN_USE", message: "This phone number is already verified on another account." });
      throw err;
    }

    await writeAuthAudit({
      user: user._id, email: user.email,
      event: changed ? "phone_changed" : "phone_verified", success: true, req,
      metadata: changed ? { from: oldMasked, to: maskPhone(target), method: active.channel } : { method: active.channel },
    });
    return res.json({ code: "VERIFIED", message: "Phone number verified.", user: { phoneVerified: true, phone: maskPhone(target) } });
  } catch (e) {
    console.warn("[phone.verify]", e.message);
    return res.status(400).json({ code: "INVALID_CODE", message: "Verification failed." });
  }
};

// POST /api/auth/phone/resend  { channel? }
exports.resend = async (req, res) => {
  if (!phoneEnabled()) return res.status(404).json({ message: "Phone verification is not enabled." });
  try {
    const user = req.user;
    if (!user.pendingPhone) return res.status(400).json({ message: "No phone verification is in progress." });
    const channel = ["sms", "whatsapp", "voice"].includes(req.body.channel) ? req.body.channel : "sms";
    bumpAttempts(user); await user.save();
    const out = await issuePhoneOtp(user, user.pendingPhone, user.pendingPhoneCountry, channel, req, { resend: true });
    const resp = { message: "A new code has been sent.", to: maskPhone(user.pendingPhone), channel };
    if (devEcho()) resp.devCode = out.devCode;
    return res.json(resp);
  } catch (e) {
    if (e.code === "COOLDOWN") return res.status(429).json({ message: e.message, retryAfter: e.wait });
    if (e.code === "CAP") return res.status(429).json({ message: e.message });
    return res.status(500).json({ message: "Could not resend the code." });
  }
};
