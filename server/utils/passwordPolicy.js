const bcrypt = require("bcryptjs");
const { isBreached } = require("./hibp");

const MIN_LEN = Number(process.env.PASSWORD_MIN_LEN || 12);
const HISTORY = Number(process.env.PASSWORD_HISTORY || 5);
const hibpOn = () => process.env.HIBP_ENABLED !== "false";

// True if `pw` matches the current password or any of the last-N hashes.
async function isReused(pw, user) {
  if (user.password && (await bcrypt.compare(pw, user.password))) return true;
  for (const h of user.passwordHistory || []) {
    if (h && (await bcrypt.compare(pw, h))) return true;
  }
  return false;
}

// Policy: min 12 chars, passphrases allowed, NO forced complexity. + reuse + HIBP.
// Requires `user` loaded with +password +passwordHistory.
async function validateNewPassword(pw, user) {
  if (!pw || String(pw).length < MIN_LEN) {
    return { ok: false, code: "WEAK_PASSWORD", message: "Password must be at least " + MIN_LEN + " characters." };
  }
  if (await isReused(pw, user)) {
    return { ok: false, code: "PASSWORD_REUSED", message: "Please choose a password you haven't used recently." };
  }
  if (hibpOn() && (await isBreached(pw))) {
    return { ok: false, code: "BREACHED_PASSWORD", message: "This password has appeared in a known data breach. Please choose a different one." };
  }
  return { ok: true };
}

// Push the CURRENT hash into history (trim to N) and set the new (plaintext) password;
// the User pre-save hook hashes it on save.
function applyNewPassword(user, pw) {
  if (user.password) user.passwordHistory = [user.password, ...(user.passwordHistory || [])].slice(0, HISTORY);
  user.password = pw;
  user.passwordChangedAt = new Date();
}

module.exports = { validateNewPassword, applyNewPassword, MIN_LEN, HISTORY };
