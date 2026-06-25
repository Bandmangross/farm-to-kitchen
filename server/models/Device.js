const mongoose = require("mongoose");

// One record per (user, device). The deviceId is a server-issued UUID stored in an
// HttpOnly cookie — NO browser fingerprinting. Used for the "active devices" list,
// new-device awareness, and tying refresh sessions to a device.
const deviceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    deviceId: { type: String, required: true }, // UUID from the ftk_device cookie
    browser: { type: String, default: "" },     // parsed from the User-Agent
    os: { type: String, default: "" },
    ipAddress: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    lastLoginAt: { type: Date, default: null },   // Phase 2.6: last successful sign-in on this device
    approxCity: { type: String, default: "" },    // Phase 2.6: COARSE geo only (city)
    approxCountry: { type: String, default: "" },  // Phase 2.6: COARSE geo only (ISO-3166 alpha-2)
    trusted: { type: Boolean, default: false },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

deviceSchema.index({ user: 1, deviceId: 1 }, { unique: true });

module.exports = mongoose.model("Device", deviceSchema);
