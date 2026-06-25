const mongoose = require("mongoose");

// Schema defined in Phase 2.1; POPULATED in Phase 2.2/2.3 (email/phone verification,
// password reset). Codes are stored HASHED (HMAC/sha256), never raw, and auto-expire
// via a TTL index. Resend cooldown + attempt caps are enforced by the controller.
const verificationCodeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    channel: { type: String, enum: ["email", "sms", "whatsapp", "voice"], required: true },
    purpose: { type: String, enum: ["email_verify", "phone_verify", "password_reset"], required: true },
    // codeHash is set for self-managed codes (email, phone DEV fallback). With Twilio
    // Verify the OTP lives on Twilio's side and is NEVER stored here.
    codeHash: { type: String, default: "" },
    tokenHash: { type: String, default: "" },     // hash of the link token (Phase 2.2: link + code)
    providerRef: { type: String, default: "" },   // Twilio Verify SID (Phase 2.3)
    status: { type: String, default: "" },         // provider status (pending/approved/…)
    // Phase 2.4: link and code can expire INDEPENDENTLY (link 30m, code 10m).
    linkExpiresAt: { type: Date, default: null },
    codeExpiresAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },     // doc-level TTL (= the later of the two)
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    sendCount: { type: Number, default: 1 },
    lastSentAt: { type: Date, default: Date.now },
    consumedAt: { type: Date, default: null },
    ip: { type: String, default: "" },
  },
  { timestamps: true }
);

verificationCodeSchema.index({ user: 1, purpose: 1 });
verificationCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL: drop at expiry

module.exports = mongoose.model("VerificationCode", verificationCodeSchema);
