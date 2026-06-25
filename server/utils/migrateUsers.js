// Phase 2.1 user migration — idempotent. Targets ONLY legacy docs that pre-date the
// new identity fields (no `accountStatus`). Existing accounts are set to "active"
// (they pre-date verification, so we don't lock them out); admins are marked verified.
// Re-running is safe: once migrated, no doc matches the legacy filter.
//   Run from server/:  node utils/migrateUsers.js
require("dotenv").config();
const mongoose = require("mongoose");

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const col = mongoose.connection.db.collection("users");

  const legacy = await col.find({ accountStatus: { $exists: false } }).toArray();
  for (const u of legacy) {
    await col.updateOne(
      { _id: u._id },
      {
        $set: {
          accountStatus: "active",          // existing accounts pre-date verification
          emailVerified: u.role === "admin",
          phoneVerified: false,
          failedLoginAttempts: 0,
          lockUntil: null,
          passwordChangedAt: u.updatedAt || u.createdAt || new Date(),
          tokenVersion: 0,
          lastLoginAt: null,
          lastLoginIp: "",
          deletedAt: null,
        },
      }
    );
  }

  const total = await col.countDocuments();
  console.log(`Migrated ${legacy.length} legacy user(s) of ${total} total.`);
  legacy.forEach((u) => console.log("  • " + u.email + " (" + u.role + ") → active" + (u.role === "admin" ? ", emailVerified" : "")));
  await mongoose.disconnect();
}

run().catch((e) => { console.error("Migration failed:", e.message); process.exit(1); });
