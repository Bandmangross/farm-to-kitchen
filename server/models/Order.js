const mongoose = require("mongoose");

const orderItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
    name: { type: String, required: true },
    quantity: { type: String, default: "1" }, // display label e.g. "2kg", "Tray"
    variantLabel: { type: String, default: "" }, // EXPLICIT variant identity for inventory (falls back to quantity)
    units: { type: Number, default: 1 }, // legacy numeric kg used for non-variant stock math
    price: { type: Number, default: 0 }, // line total
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
      enum: ["Awaiting Payment", "Paid", "Processing", "Shipped", "Delivered", "Cancelled"],
      default: "Awaiting Payment",
    },
    transactionRef: { type: String, default: null },
    stockDeducted: { type: Boolean, default: false }, // guards against double deduction
    date: { type: String }, // human-readable date kept for parity with the old UI
  },
  { timestamps: true }
);

module.exports = mongoose.model("Order", orderSchema);
