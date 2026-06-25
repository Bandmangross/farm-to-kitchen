const mongoose = require("mongoose");

// Phase 3 (decision 10) — dedicated audit trail for admin commerce actions
// (cancel / refund / manual release / status change / gateway refund). Separate
// from AuthAuditLog (security) and the free-text ActivityLog. Append-only;
// records who/what/when + before→after for every back-office mutation.
const commerceAuditSchema = new mongoose.Schema(
  {
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    adminEmail: { type: String, default: "" },
    action: {
      type: String,
      required: true,
      enum: ["order_cancelled", "order_refunded", "reservation_released", "status_changed", "gateway_refund"],
    },
    orderId: { type: String, default: "" },
    before: { type: Object, default: {} },
    after: { type: Object, default: {} },
    amount: { type: Number },
    reason: { type: String, default: "" },
    success: { type: Boolean, default: true },
    ipAddress: { type: String, default: "" },
  },
  { timestamps: true }
);

commerceAuditSchema.index({ orderId: 1, createdAt: -1 });
commerceAuditSchema.index({ admin: 1, createdAt: -1 });

module.exports = mongoose.model("CommerceAuditLog", commerceAuditSchema);
