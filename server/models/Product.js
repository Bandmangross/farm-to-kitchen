const mongoose = require("mongoose");

// Universal variant/unit model. Each variant is a sellable unit with its OWN
// price and stock (e.g. Rice "5kg", Eggs "Tray", Water "50cl", Palm Oil "5L").
// `label` is the variant's identity — unique within a product. Products with an
// empty `variants` array fall back to the legacy kg-tier behaviour (backward compat).
const variantSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true }, // e.g. "5kg", "Tray", "Carton"
    price: { type: Number, default: 0, min: 0 },         // price for ONE of this variant
    stock: { type: Number, default: 0, min: 0 },         // independent stock for this variant
    reserved: { type: Number, default: 0, min: 0 },      // Phase 3: held by unpaid orders (available = stock - reserved)
  },
  { _id: false }
);

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    sku: { type: String, unique: true, trim: true },
    category: { type: String, default: "General", trim: true },
    // For variant products: price = lowest variant price ("From ₦"), stock = sum of
    // variant stock. Kept in sync so legacy readers (analytics, admin table,
    // stock-status badges) keep working without change.
    price: { type: Number, required: true, min: 0 },
    stock: { type: Number, default: 0, min: 0 },
    reserved: { type: Number, default: 0, min: 0 }, // Phase 3: legacy (non-variant) reservation hold
    variants: { type: [variantSchema], default: [] }, // empty = legacy kg-tier product
    image: { type: String, default: "" },
    description: { type: String, default: "" },
    tag: { type: String, default: "" },
    // Catalog lifecycle / visibility:
    //   • active   → shown on the storefront
    //   • draft    → hidden from storefront (work-in-progress), still editable in admin
    //   • archived → hidden, kept for historical orders/receipts/analytics
    status: { type: String, enum: ["draft", "active", "archived"], default: "active" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Product", productSchema);
