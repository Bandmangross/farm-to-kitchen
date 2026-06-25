// Phase 2.2 email migration — idempotent. Backfills emailOriginal + emailNormalized
// (+ default language) for users that pre-date Phase 2.2. Re-running is safe.
//   Run from server/:  node utils/migrateEmails.js
require("dotenv").config();
const mongoose = require("mongoose");
const { normalizeEmail } = require("./email");

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const col = mongoose.connection.db.collection("users");

  const legacy = await col.find({ emailNormalized: { $exists: false } }).toArray();
  for (const u of legacy) {
    await col.updateOne(
      { _id: u._id },
      { $set: {
          emailOriginal: u.email,
          emailNormalized: normalizeEmail(u.email),
          language: u.language || "en",
      } }
    );
  }

  const total = await col.countDocuments();
  console.log(`Email-migrated ${legacy.length} user(s) of ${total} total.`);
  legacy.forEach((u) => console.log("  • " + u.email + " → normalized " + normalizeEmail(u.email)));
  await mongoose.disconnect();
}

run().catch((e) => { console.error("Email migration failed:", e.message); process.exit(1); });
