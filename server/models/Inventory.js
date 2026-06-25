const mongoose = require("mongoose");

// Stock-movement ledger — one record per stock change (restock, sale, manual set).
const inventorySchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
    productName: { type: String },
    type: { type: String, enum: ["in", "out", "set"], required: true },
    quantity: { type: Number, required: true },
    balanceAfter: { type: Number },
    reason: { type: String, default: "" }, // "sale", "restock", "admin adjustment"
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Inventory", inventorySchema);
