// OPS-ONLY admin MFA recovery. Run with server/DB access when an admin has lost BOTH
// their authenticator and recovery codes. Disables MFA for the named admin and forces
// re-enrollment on next login. Fully audited.
//   Run from server/:  node utils/adminMfaReset.js admin@farmtokitchen.com
require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");
const { writeAuthAudit } = require("./audit");

async function run() {
  const email = (process.argv[2] || "").toLowerCase();
  if (!email) { console.error("Usage: node utils/adminMfaReset.js <admin-email>"); process.exit(1); }
  await mongoose.connect(process.env.MONGODB_URI);
  const user = await User.findOne({ email });
  if (!user || user.role !== "admin") { console.error("No admin found for " + email); process.exit(1); }

  user.mfaEnabled = false;
  user.mfaSecret = "";
  user.mfaPendingSecret = "";
  user.recoveryCodes = [];
  user.mfaEnrolledAt = null;
  user.mfaFailedAttempts = 0;
  user.mfaLockUntil = null;
  user.tokenVersion = (user.tokenVersion || 0) + 1; // kill any active admin sessions
  await user.save();
  await writeAuthAudit({ user: user._id, email: user.email, event: "admin_mfa_reset", success: true, metadata: { via: "ops_cli" } });

  console.log("✔ MFA reset for " + email + ". They must re-enroll on next admin login.");
  await mongoose.disconnect();
}

run().catch((e) => { console.error("Reset failed:", e.message); process.exit(1); });
