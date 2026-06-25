const mongoose = require("mongoose");

// A refresh-token session. The raw refresh token is NEVER stored — only its SHA-256
// hash. Rotated on every /auth/token/refresh; revoked on logout. Enables server-side
// revocation and the "active sessions" inventory.
const sessionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    device: { type: mongoose.Schema.Types.ObjectId, ref: "Device" },
    refreshTokenHash: { type: String, required: true, index: true },
    ipAddress: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    rotatedTo: { type: String, default: null }, // hash of the successor token (rotation chain)
  },
  { timestamps: true }
);

sessionSchema.index({ user: 1, revokedAt: 1 });
// TTL cleanup: drop sessions 7 days past expiry.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

module.exports = mongoose.model("Session", sessionSchema);
