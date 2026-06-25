const mongoose = require("mongoose");

// Security audit trail — separate from the admin dashboard's ActivityLog.
// NEVER stores passwords, tokens, or OTP codes. Events emitted in Phase 2.1:
// login, logout, address_update. The rest are emitted as their flows ship (2.2–2.3).
const authAuditSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }, // null for failed logins of unknown emails
    email: { type: String, default: "" },
    event: {
      type: String,
      required: true,
      enum: [
        "login",
        "logout",
        "password_change",
        "password_reset",
        "email_verification",
        "phone_verification",
        "address_update",
        // Phase 2.2 granular email-verification events
        "email_sent",
        "email_resent",
        "email_verified",
        "email_verify_failed",
        "email_expired",
        // Phase 2.3 granular phone-verification events
        "phone_otp_sent",
        "phone_otp_resent",
        "phone_verified",
        "phone_verify_failed",
        "phone_expired",
        "phone_changed",
        "phone_risk_flagged",
        // Phase 2.5 admin MFA / hardening
        "admin_login",
        "admin_login_failed",
        "admin_mfa_setup",
        "admin_mfa_enabled",
        "admin_mfa_disabled",
        "admin_mfa_challenge_failed",
        "admin_recovery_used",
        "admin_recovery_regenerated",
        "admin_mfa_reset",
        // Phase 2.6 customer session / device management + login anomaly alerts
        "new_device_login",
        "session_revoked",
        "all_sessions_revoked",
      ],
    },
    success: { type: Boolean, default: true },
    ipAddress: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    deviceId: { type: String, default: "" },
    metadata: { type: Object, default: {} }, // safe context only (e.g. reason: "bad_password")
  },
  { timestamps: true }
);

authAuditSchema.index({ user: 1, createdAt: -1 });
authAuditSchema.index({ event: 1, createdAt: -1 });

module.exports = mongoose.model("AuthAuditLog", authAuditSchema);
