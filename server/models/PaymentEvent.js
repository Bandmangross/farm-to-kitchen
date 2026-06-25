const mongoose = require("mongoose");

// Phase 3 — append-only gateway event log (distinct from the Payment record, which
// is the settled charge). Captures every verify/webhook/mismatch/duplicate so
// settlement is auditable and idempotent. NEVER overwritten.
const paymentEventSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
    orderId: { type: String, default: "" },
    reference: { type: String, default: "" },
    type: { type: String, enum: ["initialized", "verified", "webhook", "mismatch", "duplicate", "refund"], required: true },
    status: { type: String, default: "" }, // gateway status, e.g. "success"
    amount: { type: Number },               // naira (server-side expectation or gateway value)
    currency: { type: String, default: "NGN" },
    source: { type: String, default: "" },  // "confirm" | "webhook" | "reconcile" | "admin"
    payload: { type: Object, default: {} },  // raw gateway payload (no secrets)
    ipAddress: { type: String, default: "" },
  },
  { timestamps: true }
);

paymentEventSchema.index({ orderId: 1, createdAt: -1 });
paymentEventSchema.index({ reference: 1, createdAt: -1 });

module.exports = mongoose.model("PaymentEvent", paymentEventSchema);
