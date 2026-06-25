const crypto = require("crypto");
const bcrypt = require("bcryptjs");

// Generate N human-friendly recovery codes ("ABCDE-FGHIJ"). Shown ONCE; only their
// bcrypt hashes are stored. Single-use (marked usedAt on consumption).
function gen(n = 10) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const raw = crypto.randomBytes(5).toString("hex").toUpperCase(); // 10 hex chars
    out.push(raw.slice(0, 5) + "-" + raw.slice(5));
  }
  return out;
}

const norm = (c) => String(c).replace(/[^A-Za-z0-9]/g, "").toUpperCase();

async function hashAll(codes) {
  return Promise.all(codes.map(async (c) => ({ codeHash: await bcrypt.hash(norm(c), 10), usedAt: null })));
}

// Return the matching UNUSED recovery entry, or null.
async function match(input, recoveryCodes) {
  const candidate = norm(input);
  for (const rc of recoveryCodes || []) {
    if (!rc.usedAt && (await bcrypt.compare(candidate, rc.codeHash))) return rc;
  }
  return null;
}

module.exports = { gen, hashAll, match };
