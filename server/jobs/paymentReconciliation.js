const Order = require("../models/Order");
const paystack = require("../utils/paystack");
const { settleOrder } = require("../controllers/paymentController");

// Phase 3 — reconcile orders the customer paid for but whose confirm call never
// landed (tab closed, network drop). Re-verifies any Awaiting-Payment order that
// carries a transaction reference and settles it idempotently. Safe no-op without
// a Paystack key configured.
async function reconcileOnce() {
  if (process.env.ENABLE_COMMERCE_INTEGRITY !== "true") return 0;
  if (!process.env.PAYSTACK_SECRET_KEY || process.env.PAYSTACK_SECRET_KEY.includes("xxxx")) return 0;

  const candidates = await Order.find({
    paymentStatus: "Awaiting Payment",
    transactionRef: { $ne: null },
    status: { $ne: "Cancelled" },
  }).limit(50);

  let n = 0;
  for (const o of candidates) {
    try {
      const v = await paystack.verifyTransaction(o.transactionRef);
      const d = v && v.data;
      if (d && d.status === "success") {
        await settleOrder(o, d, { reference: o.transactionRef, source: "reconcile", req: null });
        n++;
      }
    } catch (e) { console.warn("[reconcile] " + o.orderId + ": " + e.message); }
  }
  if (n) console.log(`[reconcile] settled ${n} order(s)`);
  return n;
}

function start() {
  const ms = Number(process.env.RECONCILE_INTERVAL_MS || 300000);
  const t = setInterval(() => reconcileOnce().catch((e) => console.warn("[reconcile] " + e.message)), ms);
  if (t.unref) t.unref();
  return t;
}

module.exports = { reconcileOnce, start };
