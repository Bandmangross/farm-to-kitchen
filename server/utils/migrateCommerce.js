// Phase 3 — idempotent, additive backfill. Safe to run any number of times.
//   • Products/variants: ensure `reserved` defaults to 0.
//   • Orders: backfill currency, server totals (from existing grandTotal/total),
//     version, and inventoryState derived from current status. No destructive edits.
// Run from server/:  node utils/migrateCommerce.js
require("dotenv").config();
const mongoose = require("mongoose");
const Product = require("./../models/Product");
const Order = require("./../models/Order");
const Counter = require("./../models/Counter");
const StockLedger = require("./../models/StockLedger");
const PaymentEvent = require("./../models/PaymentEvent");
const CommerceAuditLog = require("./../models/CommerceAuditLog");

// Collections must EXIST before they can be written inside a transaction
// (MongoDB forbids implicit collection creation in a multi-doc transaction).
// createCollection is idempotent-safe (ignore "already exists"). Also builds indexes.
async function ensureCollections() {
  for (const M of [Counter, StockLedger, PaymentEvent, CommerceAuditLog]) {
    try { await M.createCollection(); } catch (e) { if (!/exists/i.test(e.message)) throw e; }
    try { await M.syncIndexes(); } catch (e) { console.warn("[migrate] syncIndexes " + M.modelName + ": " + e.message); }
  }
}

function inventoryStateFor(order) {
  if (order.stockDeducted) return "committed";
  if (order.status === "Cancelled") return "released";
  if (order.paymentStatus === "Awaiting Payment") return "none"; // legacy orders never reserved
  return "none";
}

async function run() {
  const standalone = mongoose.connection.readyState !== 1;
  if (standalone) await mongoose.connect(process.env.MONGODB_URI);

  await ensureCollections();

  let pTouched = 0;
  const products = await Product.find({});
  for (const p of products) {
    let dirty = false;
    if (typeof p.reserved !== "number") { p.reserved = 0; dirty = true; }
    if (Array.isArray(p.variants)) {
      for (const v of p.variants) {
        if (typeof v.reserved !== "number") { v.reserved = 0; dirty = true; }
      }
      if (dirty) p.markModified("variants");
    }
    if (dirty) { await p.save(); pTouched++; }
  }

  let oTouched = 0;
  const orders = await Order.find({});
  for (const o of orders) {
    let dirty = false;
    if (!o.currency) { o.currency = "NGN"; dirty = true; }
    if (!o.serverTotal && o.total) { o.serverTotal = o.total; dirty = true; }
    if (!o.serverGrandTotal && o.grandTotal) { o.serverGrandTotal = o.grandTotal; dirty = true; }
    if (typeof o.version !== "number") { o.version = 0; dirty = true; }
    if (!o.inventoryState || o.inventoryState === "none") {
      const st = inventoryStateFor(o);
      if (st !== o.inventoryState) { o.inventoryState = st; dirty = true; }
    }
    if (dirty) { await o.save(); oTouched++; }
  }

  console.log(`✔ migrateCommerce: products updated ${pTouched}/${products.length}, orders updated ${oTouched}/${orders.length}`);
  if (standalone) await mongoose.disconnect();
  return { pTouched, oTouched };
}

if (require.main === module) {
  run().catch((e) => { console.error("migrateCommerce failed:", e.message); process.exit(1); });
}
module.exports = run;
module.exports.ensureCollections = ensureCollections;
