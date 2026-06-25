const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true },
    // `email` keeps the lowercased original (back-compat). Phase 2.2 adds explicit
    // original + normalized forms; UNIQUENESS is enforced on emailNormalized.
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    emailOriginal: { type: String, default: "", trim: true }, // exactly as typed (used to SEND mail)
    emailNormalized: { type: String, unique: true, sparse: true, lowercase: true, trim: true }, // canonical (dedup)
    language: { type: String, default: "en" }, // i18n-ready (en now; fr/es/de/pt/ar future)
    phone: { type: String, trim: true },
    address: { type: String, default: "", trim: true }, // default delivery address
    password: { type: String, required: true, select: false }, // never returned by default
    role: { type: String, enum: ["customer", "admin"], default: "customer" },
    joinDate: { type: Date, default: Date.now },

    // ── Phase 2.1: identity lifecycle & security ──
    // Soft-delete is the platform standard — accounts are never hard-deleted.
    accountStatus: {
      type: String,
      enum: ["pending_verification", "active", "locked", "suspended", "deleted"],
      default: "pending_verification",
    },
    emailVerified: { type: Boolean, default: false },
    phoneVerified: { type: Boolean, default: false },
    failedLoginAttempts: { type: Number, default: 0 },
    lockUntil: { type: Date, default: null },
    passwordChangedAt: { type: Date, default: null },
    passwordHistory: { type: [String], default: [], select: false }, // last N bcrypt hashes (Phase 2.4 reuse prevention)
    tokenVersion: { type: Number, default: 0 }, // bump to invalidate ALL access tokens (logout-all)
    lastLoginAt: { type: Date, default: null },
    lastLoginIp: { type: String, default: "" },
    deletedAt: { type: Date, default: null }, // set when accountStatus === "deleted"

    // ── Phase 2.5: admin MFA (TOTP) — admin accounts only ──
    mfaEnabled: { type: Boolean, default: false },
    mfaSecret: { type: String, default: "", select: false },         // AES-GCM encrypted TOTP secret
    mfaPendingSecret: { type: String, default: "", select: false },  // during setup, before enable
    mfaEnrolledAt: { type: Date, default: null },
    recoveryCodes: { type: [{ codeHash: String, usedAt: Date }], default: [], select: false }, // hashed, single-use
    mfaFailedAttempts: { type: Number, default: 0 },
    mfaLockUntil: { type: Date, default: null },

    // ── Phase 2.2: verification outcome (future-proof, generic across channels) ──
    verifiedAt: { type: Date, default: null },
    verificationMethod: { type: String, default: "" }, // "link" | "code"
    verificationIp: { type: String, default: "" },

    // ── Phase 2.3: phone verification ──
    phoneE164: { type: String, unique: true, sparse: true, trim: true }, // one verified number per account
    phoneCountryCode: { type: String, default: "" },        // calling code, e.g. "234"
    phoneVerifiedAt: { type: Date, default: null },
    phoneVerificationMethod: { type: String, default: "" }, // "sms" | "whatsapp" | "voice"
    phoneVerificationIp: { type: String, default: "" },
    phoneVerificationCountry: { type: String, default: "" }, // ISO-2, e.g. "NG"
    phoneRiskFlag: { type: Boolean, default: false },        // VoIP/disposable flagged (allowed w/ friction)
    pendingPhone: { type: String, default: "" },             // number being verified (during add/change)
    pendingPhoneCountry: { type: String, default: "" },
    // Fraud/trust data-collection ONLY (no enforcement this phase)
    phoneVerificationAttemptsToday: { type: Number, default: 0 },
    phoneAttemptsResetAt: { type: Date, default: null },
    phoneLastVerifiedAt: { type: Date, default: null },
    phoneRiskScore: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Hash the password whenever it is set/changed.
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.model("User", userSchema);
