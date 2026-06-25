const mongoose = require("mongoose");

// Phase 3 — immutable stock-movement ledger. One row per (order, type, product,
// variant) movement. The compound unique index is the IDEMPOTENCY guard: a given
// order can only ever reserve/commit/release/refund a given line ONCE, so a
// duplicate payment-confirm or webhook replay cannot double-apply inventory.
const stockLedgerSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
    productName: { type: String, default: "" },
    variantLabel: { type: String, default: "" }, // "" for legacy non-variant lines
    orderId: { type: String, default: "" },
    type: { type: String, enum: ["reserve", "commit", "release", "refund", "restock", "adjust"], required: true },
    quantity: { type: Number, required: true },
    reservedAfter: { type: Number },
    stockAfter: { type: Number },
    reason: { type: String, default: "" },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

// Idempotency: at most one movement of a given type per order line.
stockLedgerSchema.index({ orderId: 1, type: 1, product: 1, variantLabel: 1 }, { unique: true, partialFilterExpression: { orderId: { $gt: "" } } });
stockLedgerSchema.index({ product: 1, createdAt: -1 });

module.exports = mongoose.model("StockLedger", stockLedgerSchema);
