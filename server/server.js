require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose"); // read the live connection state for readiness (WS6A)
const connectDB = require("./config/db");
const errorHandler = require("./middleware/errorHandler");

const app = express();

// ── Core middleware ──
// Behind a proxy/load balancer in prod → trust X-Forwarded-* so req.ip is correct.
app.set("trust proxy", 1);
// Security headers. CSP/COEP disabled for now because the client uses inline
// scripts/styles + base64 images; CSP hardening is a later phase.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
// CORS with credentials so HttpOnly auth cookies flow on same-origin (and on an
// allow-listed CLIENT_ORIGIN in production). `origin: true` echoes the request
// origin, which is required when credentials are enabled.
app.use(cors({ origin: process.env.CLIENT_ORIGIN || true, credentials: true }));

// Paystack webhook (Phase 3) — MUST be registered with a RAW body parser BEFORE the
// JSON parser so the HMAC-SHA512 signature is verified over the exact signed bytes.
app.post("/api/payments/webhook", express.raw({ type: "*/*" }), require("./controllers/paymentController").webhook);

app.use(express.json({ limit: "5mb" })); // 5mb allows base64 product images
app.use(cookieParser());

// ── API routes ──
app.use("/api", require("./routes/auth")); // /api/register, /api/login, /api/logout, /api/me
app.use("/api/users", require("./routes/users"));
app.use("/api/products", require("./routes/products"));
app.use("/api/orders", require("./routes/orders"));
app.use("/api/payments", require("./routes/payments"));
app.use("/api/analytics", require("./routes/analytics"));
app.use("/api/admin", require("./routes/admin")); // Phase 3 — admin orders dashboard (flag-gated)

// Liveness — "is the Node process up and serving?" Never depends on external deps,
// so an orchestrator (Render) won't restart-loop the app during a DB outage.
app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date() }));

// Readiness (WS6A) — "can we actually serve real requests?" 200 only when MongoDB is
// connected (readyState === 1); 503 otherwise. Read-only, synchronous (no DB round-trip).
app.get("/api/ready", (req, res) => {
  const states = ["disconnected", "connected", "connecting", "disconnecting"];
  const state = mongoose.connection.readyState; // 0|1|2|3 (in-memory enum)
  const ready = state === 1;
  res.status(ready ? 200 : 503).json({ ready, db: states[state] || "unknown", time: new Date() });
});

// ── Serve the static client (../client) ──
const clientDir = path.join(__dirname, "..", "client");
app.use(express.static(clientDir));
app.get("*", (req, res) => res.sendFile(path.join(clientDir, "index.html")));

// ── Errors ──
app.use(errorHandler);

// ── Production payment-config guard (WS4) ──
// Fail fast so an unsafe payment configuration can NEVER reach production. In
// development we only warn, so local testing (test key + simulated payments)
// still works. The one rule enforced everywhere: a LIVE key must never run with
// simulated payments enabled.
function assertPaymentConfig() {
  const isProd = process.env.NODE_ENV === "production";
  const key = process.env.PAYSTACK_SECRET_KEY || "";
  const liveKey = key.startsWith("sk_live_");
  const testKey = key.startsWith("sk_test_");
  const placeholderKey = !key || key.includes("xxxx");
  const simOn = process.env.ALLOW_SIMULATED_PAYMENTS === "true";
  const integrityOn = process.env.ENABLE_COMMERCE_INTEGRITY === "true";
  const webhookOn = process.env.ENABLE_PAYMENT_WEBHOOK === "true";

  const blockers = [];
  if (isProd) {
    if (placeholderKey || testKey) blockers.push("PAYSTACK_SECRET_KEY must be a LIVE key (sk_live_...) in production.");
    if (simOn) blockers.push("ALLOW_SIMULATED_PAYMENTS must be false in production.");
    if (!integrityOn) blockers.push("ENABLE_COMMERCE_INTEGRITY must be true in production (secure verification path).");
    if (!webhookOn) blockers.push("ENABLE_PAYMENT_WEBHOOK must be true in production (settlement safety net).");
  }
  // Dangerous in ANY environment: a real live key with simulation enabled.
  if (liveKey && simOn) blockers.push("ALLOW_SIMULATED_PAYMENTS must NOT be enabled while a LIVE Paystack key is in use.");

  if (blockers.length) {
    console.error("✖ Payment configuration check FAILED:");
    blockers.forEach((b) => console.error("   - " + b));
    if (isProd || (liveKey && simOn)) {
      console.error("✖ Refusing to start. Fix the configuration above and restart.");
      process.exit(1);
    }
    console.warn("⚠ (development) Continuing despite the warnings above — DO NOT ship this config to production.");
  } else {
    console.log(`✔ Payment configuration check passed (${isProd ? "production" : "development"}).`);
  }
}
assertPaymentConfig();

// ── Production auth-config guard (WS5) ──
// Mirrors the payment guard: fail fast so an unsafe authentication configuration
// can NEVER reach production. The most important rule — a default/weak JWT signing
// secret means anyone can forge admin tokens — is enforced here.
function assertAuthConfig() {
  const isProd = process.env.NODE_ENV === "production";
  const secret = process.env.JWT_SECRET || "";
  const weakSecret = !secret || secret === "change_this_to_a_long_random_secret" || secret.length < 32;

  const mfaOn = process.env.ENABLE_ADMIN_MFA === "true";
  const mfaKeyOk = Buffer.byteLength(process.env.MFA_ENC_KEY || "") >= 32;

  const resetOn = process.env.ENABLE_PASSWORD_RESET === "true";
  const verifyOn = process.env.ENABLE_EMAIL_VERIFICATION === "true";
  const mailConfigured = !!(process.env.RESEND_API_KEY || (process.env.AWS_REGION && process.env.SES_FROM));
  const appUrl = process.env.APP_URL || "";
  const appUrlOk = !!appUrl && !/localhost|127\.0\.0\.1/.test(appUrl);

  const blockers = [];
  if (isProd) {
    if (weakSecret) blockers.push("JWT_SECRET must be a strong, non-default secret (>= 32 chars) in production.");
    if (mfaOn && !mfaKeyOk) blockers.push("MFA_ENC_KEY (>= 32 bytes) is required when ENABLE_ADMIN_MFA=true.");
    if (resetOn && !mailConfigured) blockers.push("ENABLE_PASSWORD_RESET requires a mail provider (RESEND_API_KEY, or AWS_REGION + SES_FROM).");
    if (verifyOn && !mailConfigured) blockers.push("ENABLE_EMAIL_VERIFICATION requires a mail provider (RESEND_API_KEY, or AWS_REGION + SES_FROM).");
    if ((resetOn || verifyOn) && !appUrlOk) blockers.push("APP_URL must be your public site URL (not localhost) when reset/verification emails are enabled.");
  } else {
    if (weakSecret) console.warn("⚠ JWT_SECRET is weak/default — OK for dev, MUST be replaced in production.");
    if (mfaOn && !mfaKeyOk) console.warn("⚠ ENABLE_ADMIN_MFA is on without a 32-byte MFA_ENC_KEY — TOTP secrets fall back to a derived dev key.");
  }

  if (blockers.length) {
    console.error("✖ Authentication configuration check FAILED:");
    blockers.forEach((b) => console.error("   - " + b));
    console.error("✖ Refusing to start. Fix the configuration above and restart.");
    process.exit(1);
  } else {
    console.log(`✔ Authentication configuration check passed (${isProd ? "production" : "development"}).`);
  }
}
assertAuthConfig();

const PORT = process.env.PORT || 5050;
connectDB().then(async () => {
  // Phase 3: ensure commerce collections exist (so transactional writes don't try to
  // create a namespace inside a txn) + start background jobs when integrity is on.
  if (process.env.ENABLE_COMMERCE_INTEGRITY === "true") {
    try { await require("./utils/migrateCommerce").ensureCollections(); } catch (e) { console.warn("[boot] ensureCollections: " + e.message); }
    require("./jobs/reservationSweeper").start();
    require("./jobs/paymentReconciliation").start();
    console.log("✔ Phase 3 commerce integrity ON — reservation sweeper + reconciliation started");
  }
  app.listen(PORT, () => console.log(`✔ Farm To Kitchen API running on http://localhost:${PORT}`));
});
