const https = require("https");
const crypto = require("crypto");

// Server-side Paystack helpers (secret key only — never exposed to the browser).
// M3 uses verifyTransaction; M4 adds webhook signature verification + refund.

function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: "api.paystack.co",
        path,
        method,
        headers: {
          Authorization: "Bearer " + process.env.PAYSTACK_SECRET_KEY,
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (resp) => {
        let data = "";
        resp.on("data", (c) => (data += c));
        resp.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch (e) { reject(e); } });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function verifyTransaction(reference) {
  return apiRequest("GET", "/transaction/verify/" + encodeURIComponent(reference));
}

// Refund (only called when ENABLE_GATEWAY_REFUND is on — see M6).
function refundTransaction(reference, amountNaira) {
  const body = { transaction: reference };
  if (amountNaira != null) body.amount = Math.round(amountNaira * 100); // kobo
  return apiRequest("POST", "/refund", body);
}

// Verify a Paystack webhook signature: HMAC-SHA512 of the raw body, keyed by the
// SECRET key, compared to the x-paystack-signature header (timing-safe).
function verifySignature(rawBody, signature) {
  if (!process.env.PAYSTACK_SECRET_KEY || !signature) return false;
  const hash = crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY).update(rawBody).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(String(signature))); }
  catch (_) { return false; }
}

const simulationAllowed = () => process.env.ALLOW_SIMULATED_PAYMENTS === "true";

module.exports = { verifyTransaction, refundTransaction, verifySignature, simulationAllowed };
