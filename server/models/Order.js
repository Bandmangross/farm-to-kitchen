const mongoose = require("mongoose");

const orderItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
    name: { type: String, required: true },
    quantity: { type: String, default: "1" }, // display label e.g. "2kg", "Tray"
    variantLabel: { type: String, default: "" }, // EXPLICIT variant identity for inventory (falls back to quantity)
    units: { type: Number, default: 1 }, // legacy numeric kg used for non-variant stock math
    price: { type: Number, default: 0 }, // line total
    // Phase 3 — server-authoritative pricing snapshot (captured at order time).
    qty: { type: Number, default: 1 },        // discrete count of this line (variants)
    unitPrice: { type: Number, default: 0 },  // DB price for one unit at order time
    lineTotal: { type: Number, default: 0 },  // unitPrice * qty (server-computed)
  },
  { _id: false }
);

// Phase 3 — order status transition history.
const statusHistorySchema = new mongoose.Schema(
  {
    from: { type: String, default: "" },
    to: { type: String, default: "" },
    actor: { type: String, default: "system" }, // "system" | "admin" | "customer" | "gateway"
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reason: { type: String, default: "" },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true }, // FTK-2026-000001
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // null for guests
    customerName: { type: String, required: true },
    customerEmail: { type: String, required: true, lowercase: true },
    customerPhone: { type: String, default: "" },
    customerAddress: { type: String, default: "" },
    items: [orderItemSchema],
    quantity: { type: Number, default: 0 }, // number of line items
    total: { type: Number, default: 0 }, // subtotal
    deliveryFee: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },
    amount: { type: Number, default: 0 },
    paymentMethod: { type: String, default: "Paystack" },
    paymentStatus: {
      type: String,
      enum: ["Awaiting Payment", "Paid", "Unpaid", "Refunded"],
      default: "Awaiting Payment",
    },
    status: {
      type: String,
      enum: ["Awaiting Payment", "Paid", "Processing", "Shipped", "Delivered", "Cancelled", "Refunded"], // Phase 3: +Refunded
      default: "Awaiting Payment",
    },
    transactionRef: { type: String, default: null },
    stockDeducted: { type: Boolean, default: false }, // guards against double deduction (legacy path)
    date: { type: String }, // human-readable date kept for parity with the old UI
    // ── Phase 3 — commerce integrity (additive; inert when ENABLE_COMMERCE_INTEGRITY off) ──
    currency: { type: String, default: "NGN" },
    serverTotal: { type: Number, default: 0 },       // authoritative subtotal (sum of lineTotals)
    serverGrandTotal: { type: Number, default: 0 },  // authoritative total incl. delivery
    idempotencyKey: { type: String, default: null }, // client-supplied create dedup (sparse-unique)
    version: { type: Number, default: 0 },           // optimistic concurrency for transitions
    inventoryState: { type: String, enum: ["none", "reserved", "committed", "released"], default: "none" },
    reservationExpiresAt: { type: Date, default: null },
    statusHistory: { type: [statusHistorySchema], default: [] },
  },
  { timestamps: true }
);

// Sparse-unique: only enforce uniqueness when an idempotencyKey is present.
orderSchema.index({ idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } });

module.exports = mongoose.model("Order", orderSchema);
