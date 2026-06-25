const crypto = require("crypto");
const otplib = require("otplib"); // v13 functional API

const ISSUER = process.env.MFA_ISSUER || "Farm To Kitchen";

// AES-256-GCM at-rest encryption for the TOTP secret. Key from MFA_ENC_KEY (32 bytes);
// dev fallback is derived so the flow is testable, but PROD must set a real key.
function key() {
  const k = process.env.MFA_ENC_KEY || "";
  if (Buffer.byteLength(k) >= 32) return Buffer.from(k).subarray(0, 32);
  return crypto.createHash("sha256").update(k || "ftk-dev-mfa-key").digest();
}
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return [iv.toString("hex"), c.getAuthTag().toString("hex"), enc.toString("hex")].join(":");
}
function decrypt(blob) {
  const [ivh, tagh, ench] = String(blob).split(":");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivh, "hex"));
  d.setAuthTag(Buffer.from(tagh, "hex"));
  return Buffer.concat([d.update(Buffer.from(ench, "hex")), d.final()]).toString("utf8");
}

function genSecret() { return otplib.generateSecret(); } // base32
function otpauth(label, secret) { return otplib.generateURI({ secret, label, issuer: ISSUER }); }
function currentToken(secret) { return otplib.generateSync({ secret }); } // for tests/ops only
function verify(token, secret) {
  try {
    const r = otplib.verifySync({ token: String(token).trim(), secret, window: 1 });
    return !!(r && r.valid); // verifySync returns { valid, delta, ... }
  } catch (_) { return false; }
}

module.exports = { encrypt, decrypt, genSecret, otpauth, verify, currentToken };
