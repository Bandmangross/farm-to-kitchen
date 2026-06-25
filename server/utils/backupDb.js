// READ-ONLY database backup. Exports every collection to timestamped JSON files.
// Never writes to or deletes from MongoDB. Run from the server/ directory:
//   node utils/backupDb.js
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

async function backup() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error("✖ MONGODB_URI not set"); process.exit(1); }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(__dirname, "..", "..", "backups", stamp);
  fs.mkdirSync(outDir, { recursive: true });

  const collections = await db.listCollections().toArray();
  const summary = [];
  for (const c of collections) {
    const docs = await db.collection(c.name).find({}).toArray(); // read-only
    fs.writeFileSync(path.join(outDir, c.name + ".json"), JSON.stringify(docs, null, 2));
    summary.push({ collection: c.name, documents: docs.length });
  }

  console.log("✔ Backup written to: " + outDir);
  console.table(summary);
  await mongoose.disconnect();
}

backup().catch((e) => { console.error("✖ Backup failed:", e.message); process.exit(1); });
