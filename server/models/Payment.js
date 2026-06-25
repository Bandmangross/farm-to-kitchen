const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order" },
    orderId: { type: String }, // denormalised FTK-... id for convenience
    reference: { type: String, required: true, unique: true },
    amount: { type: Number, required: true }, // in Naira
    currency: { type: String, default: "NGN" },
    channel: { type: String, default: "" }, // card, bank, etc.
    status: { type: String, enum: ["success", "failed", "pending"], default: "pending" },
    customerEmail: { type: String, lowercase: true },
    gatewayResponse: { type: Object }, // raw Paystack verify payload
    paidAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Payment", paymentSchema);
