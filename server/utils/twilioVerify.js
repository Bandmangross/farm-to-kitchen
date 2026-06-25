const crypto = require("crypto");

// Twilio Verify integration with a DEV fallback so the full flow is testable without
// live Twilio credentials (mirrors the Phase 2.2 email DEV transport). When Twilio is
// configured, the OTP lifecycle (generation, 10-min expiry, attempt limit, delivery
// across SMS/WhatsApp/Voice) is delegated to Twilio Verify and NEVER stored here.

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

let _client = null; // null = unchecked, false = not configured
function client() {
  if (_client !== null) return _client;
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_VERIFY_SERVICE_SID) {
    try { _client = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN); console.log("[Twilio] Verify ready"); }
    catch (e) { console.warn("[Twilio] unavailable, using DEV fallback:", e.message); _client = false; }
  } else { _client = false; }
  return _client;
}
const SID = () => process.env.TWILIO_VERIFY_SERVICE_SID;

// Start a verification. Returns { providerRef, status, codeHash, devCode }.
async function startVerification({ phoneE164, channel }) {
  const c = client();
  if (c) {
    const v = await c.verify.v2.services(SID()).verifications.create({ to: phoneE164, channel });
    return { providerRef: v.sid, status: v.status, codeHash: "", devCode: null };
  }
  // DEV fallback: self-generate a hashed 6-digit code.
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  console.log(`[Phone:DEV] to=${phoneE164} channel=${channel} code=${code}`);
  return { providerRef: "", status: "pending", codeHash: sha(code), devCode: code };
}

// Check a code. Returns { ok }.
async function checkVerification({ phoneE164, code, doc }) {
  const c = client();
  if (c) {
    try {
      const r = await c.verify.v2.services(SID()).verificationChecks.create({ to: phoneE164, code });
      return { ok: r.status === "approved" };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  return { ok: !!doc && doc.codeHash && doc.codeHash === sha(code) };
}

// Line-type risk (VoIP/disposable). Returns { score, lineType, voip }.
async function lookupRisk(phoneE164) {
  const c = client();
  if (c && process.env.TWILIO_LOOKUP_ENABLED === "true") {
    try {
      const l = await c.lookups.v2.phoneNumbers(phoneE164).fetch({ fields: "line_type_intelligence" });
      const lt = (l.lineTypeIntelligence && l.lineTypeIntelligence.type) || "";
      const voip = lt === "voip" || lt === "nonFixedVoip";
      return { score: voip ? 70 : 10, lineType: lt, voip };
    } catch (_) { return { score: 0, lineType: "", voip: false }; }
  }
  // DEV: a configured test number (PHONE_DEV_VOIP, full E.164) simulates a VoIP/
  // high-risk line so the friction path is testable without live Twilio Lookup.
  const voip = !!process.env.PHONE_DEV_VOIP && phoneE164 === process.env.PHONE_DEV_VOIP;
  return { score: voip ? 70 : 10, lineType: voip ? "voip" : "mobile", voip };
}

module.exports = { startVerification, checkVerification, lookupRisk, sha };
