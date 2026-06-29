require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
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

app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date() }));

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
