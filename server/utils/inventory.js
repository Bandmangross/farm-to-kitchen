const mongoose = require("mongoose");
const Product = require("../models/Product");
const Inventory = require("../models/Inventory");
const StockLedger = require("../models/StockLedger");

// Resolve an order line to a Product by SKU → product id → name (in that priority).
async function findProductForItem(item) {
  if (item.sku) {
    const bySku = await Product.findOne({ sku: item.sku });
    if (bySku) return bySku;
  }
  if (item.product) {
    try {
      const byId = await Product.findById(item.product);
      if (byId) return byId;
    } catch (_) { /* not a valid ObjectId — fall through */ }
  }
  if (item.name) {
    const byName = await Product.findOne({ name: item.name });
    if (byName) return byName;
  }
  return null;
}

// EXPLICIT variant identity for a line (falls back to the display quantity for
// legacy orders that pre-date the variantLabel field).
function variantLabelOf(item) {
  return String(item.variantLabel || item.quantity || "").trim();
}

// Legacy kg quantity for NON-variant products. Falls back to 1.
function unitsOf(item) {
  return Number(item.units) || parseInt(item.quantity, 10) || 1;
}

// Find the variant subdoc on a product that matches an order line, or null.
// Matching is by label (case-insensitive) — the variant's identity.
function matchVariant(product, item) {
  if (!product || !Array.isArray(product.variants) || !product.variants.length) return null;
  const label = variantLabelOf(item).toLowerCase();
  if (!label) return null;
  return product.variants.find((v) => String(v.label).trim().toLowerCase() === label) || null;
}

// Aggregate requirements across the order's lines.
//   • Variant line  → key product+variant, need 1 unit of the variant per line.
//   • Legacy line   → key product,         need the kg figure (UNCHANGED behaviour).
// Discrete count of a variant line. Phase 3 FIX (R7): order items carry `qty`/
// `units`/`quantity` — NOT `count` — so the old `Number(it.count) || 1` always
// deducted exactly 1. Resolve the real ordered quantity instead.
function variantCountOf(item) {
  return Number(item.qty) || Number(item.count) || Number(item.units) || parseInt(item.quantity, 10) || 1;
}

async function aggregateNeeds(items) {
  const map = new Map();
  for (const it of items || []) {
    const product = await findProductForItem(it);
    if (!product) continue; // untracked product — nothing to guard/deduct
    const variant = matchVariant(product, it);
    if (variant) {
      const key = String(product._id) + "::" + String(variant.label).toLowerCase();
      const entry = map.get(key) || { product, variant, label: variant.label, need: 0 };
      entry.need += variantCountOf(it); // R7 fix: real ordered quantity of THIS variant
      map.set(key, entry);
    } else {
      if (Array.isArray(product.variants) && product.variants.length) {
        console.warn(`[Inventory] No variant matched "${variantLabelOf(it)}" on ${product.name} — falling back to product stock.`);
      }
      const key = String(product._id);
      const entry = map.get(key) || { product, variant: null, label: null, need: 0 };
      entry.need += unitsOf(it);
      map.set(key, entry);
    }
  }
  return map;
}

// Requirement 4/7: reject if any product/variant has insufficient stock.
// Returns { ok: true } or { ok: false, message }.
async function checkStockAvailability(items) {
  const map = await aggregateNeeds(items);
  for (const { product, variant, need } of map.values()) {
    const available = variant ? variant.stock : product.stock;
    if (available < need) {
      const what = variant ? `${product.name} (${variant.label})` : product.name;
      return {
        ok: false,
        message: `Insufficient stock for ${what}. Only ${available} in stock, ${need} requested.`,
      };
    }
  }
  return { ok: true };
}

// Requirement 2/3/7/8: deduct stock for a PAID order against the PURCHASED VARIANT
// only, persist to MongoDB, never go below zero, log each movement, and keep
// product.stock in sync as the sum of variant stock. Idempotent via order.stockDeducted.
async function deductStockForOrder(order) {
  if (!order) { console.warn("[Inventory] deductStockForOrder called with no order"); return; }
  if (order.stockDeducted) {
    console.log(`[Inventory] Order ${order.orderId} already deducted — skipping`);
    return; // idempotent
  }

  console.log(`[Inventory] Deducting stock for order ${order.orderId}`);
  const map = await aggregateNeeds(order.items);

  if (map.size === 0) {
    console.warn(
      `[Inventory] No matching products for order ${order.orderId}. Items: ` +
      JSON.stringify((order.items || []).map((it) => ({ name: it.name, sku: it.sku, units: it.units, quantity: it.quantity, variantLabel: it.variantLabel })))
    );
    return; // do NOT set stockDeducted — let a later attempt try again
  }

  // Group by product so each product document is saved exactly once (variants are subdocs).
  const byProduct = new Map();
  for (const entry of map.values()) {
    const pid = String(entry.product._id);
    if (!byProduct.has(pid)) byProduct.set(pid, { product: entry.product, entries: [] });
    byProduct.get(pid).entries.push(entry);
  }

  for (const { product, entries } of byProduct.values()) {
    const hasVariants = Array.isArray(product.variants) && product.variants.length > 0;

    for (const entry of entries) {
      if (entry.variant) {
        // Deduct from the matching variant subdoc only.
        const v = product.variants.find(
          (x) => String(x.label).trim().toLowerCase() === String(entry.label).trim().toLowerCase()
        );
        if (!v) continue;
        const before = v.stock;
        v.stock = Math.max(0, before - entry.need); // clamp at zero
        await Inventory.create({
          product: product._id,
          productName: `${product.name} — ${v.label}`,
          type: "out",
          quantity: entry.need,
          balanceAfter: v.stock,
          reason: "sale (paid order " + (order.orderId || "") + ")",
        });
        console.log(`[Inventory] ${product.name} [${v.label}] | Before: ${before} | Sold: ${entry.need} | After: ${v.stock}`);
      } else {
        // Legacy product (no variants) — deduct from product.stock as before.
        const before = product.stock;
        product.stock = Math.max(0, before - entry.need);
        await Inventory.create({
          product: product._id,
          productName: product.name,
          type: "out",
          quantity: entry.need,
          balanceAfter: product.stock,
          reason: "sale (paid order " + (order.orderId || "") + ")",
        });
        console.log(`[Inventory] ${product.name} | Before: ${before} | Sold: ${entry.need} | After: ${product.stock}`);
      }
    }

    // Requirement 3: product.stock is DERIVED from total variant stock.
    if (hasVariants) {
      product.stock = product.variants.reduce((s, v) => s + (Number(v.stock) || 0), 0);
      product.markModified("variants");
    }
    await product.save(); // persisted in MongoDB
  }

  order.stockDeducted = true; // mark so payment-confirm can't deduct a second time
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — transactional reserve / commit / release / refund engine.
// Active only on the ENABLE_COMMERCE_INTEGRITY path; the legacy functions above
// remain untouched for the flag-off path. Inventory truth is enforced with atomic
// availability guards inside a MongoDB multi-document transaction (decision 4):
// available(variant) = stock − reserved; product.stock stays the sum of variant
// stock by decrementing the top-level stock alongside the variant on commit/refund.
// ─────────────────────────────────────────────────────────────────────────────

function insufficient(what) {
  const e = new Error("Insufficient stock for " + what + ".");
  e.code = "INSUFFICIENT_STOCK";
  return e;
}

// Run fn inside a transaction; mongoose retries on transient/write-conflict errors.
async function withTxn(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await fn(session); });
    return result;
  } finally {
    session.endSession();
  }
}

async function writeLedger(session, p) {
  await StockLedger.create([{
    product: p.product._id, productName: p.product.name, variantLabel: p.variantLabel || "",
    orderId: p.orderId || "", type: p.type, quantity: p.quantity,
    reservedAfter: p.reservedAfter, stockAfter: p.stockAfter, reason: p.reason || "", user: p.userId || null,
  }], { session });
}

// $expr guarding availability of the variant matched by label (field-vs-field safe).
function variantAvailableExpr(label, need) {
  return {
    $let: {
      vars: { v: { $first: { $filter: { input: "$variants", cond: { $eq: ["$$this.label", label] } } } } },
      in: { $gte: [{ $subtract: ["$$v.stock", { $ifNull: ["$$v.reserved", 0] }] }, need] },
    },
  };
}
function variantReservedExpr(label, need) {
  return {
    $let: {
      vars: { v: { $first: { $filter: { input: "$variants", cond: { $eq: ["$$this.label", label] } } } } },
      in: { $gte: [{ $ifNull: ["$$v.reserved", 0] }, need] },
    },
  };
}
const variantOf = (doc, label) => doc.variants.find((x) => String(x.label).trim().toLowerCase() === String(label).trim().toLowerCase());

// Apply one inventory movement to one line. `op` ∈ reserve|commit|release|refund.
async function applyLine(op, entry, orderId, session) {
  const { product, variant, label, need } = entry;
  const pid = product._id;

  if (variant) {
    let query, update, arrayFilters, guardName;
    if (op === "reserve") {
      query = { _id: pid, $expr: variantAvailableExpr(variant.label, need) };
      update = { $inc: { "variants.$[v].reserved": need } };
    } else if (op === "commit") {
      // From a held reservation: convert reserved → out (stock and reserved both drop).
      query = { _id: pid, $expr: variantReservedExpr(variant.label, need) };
      update = { $inc: { "variants.$[v].reserved": -need, "variants.$[v].stock": -need, stock: -need } };
    } else if (op === "commitDirect") {
      // No live reservation (released/none) — guard available, drop stock only.
      query = { _id: pid, $expr: variantAvailableExpr(variant.label, need) };
      update = { $inc: { "variants.$[v].stock": -need, stock: -need } };
    } else if (op === "release") {
      query = { _id: pid, $expr: variantReservedExpr(variant.label, need) };
      update = { $inc: { "variants.$[v].reserved": -need } };
    } else if (op === "refund") {
      query = { _id: pid };
      update = { $inc: { "variants.$[v].stock": need, stock: need } };
    }
    arrayFilters = [{ "v.label": variant.label }];
    const updated = await Product.findOneAndUpdate(query, update, { new: true, session, arrayFilters });
    if (!updated) throw insufficient(product.name + " (" + variant.label + ")");
    const v = variantOf(updated, variant.label);
    await writeLedger(session, { product, variantLabel: variant.label, orderId, type: op === "commitDirect" ? "commit" : op, quantity: need, reservedAfter: v.reserved, stockAfter: v.stock });
    return;
  }

  // Legacy (non-variant) product.
  let query, update;
  if (op === "reserve") {
    query = { _id: pid, $expr: { $gte: [{ $subtract: ["$stock", { $ifNull: ["$reserved", 0] }] }, need] } };
    update = { $inc: { reserved: need } };
  } else if (op === "commit") {
    query = { _id: pid, $expr: { $gte: [{ $ifNull: ["$reserved", 0] }, need] } };
    update = { $inc: { reserved: -need, stock: -need } };
  } else if (op === "commitDirect") {
    query = { _id: pid, stock: { $gte: need } };
    update = { $inc: { stock: -need } };
  } else if (op === "release") {
    query = { _id: pid, $expr: { $gte: [{ $ifNull: ["$reserved", 0] }, need] } };
    update = { $inc: { reserved: -need } };
  } else if (op === "refund") {
    query = { _id: pid };
    update = { $inc: { stock: need } };
  }
  const updated = await Product.findOneAndUpdate(query, update, { new: true, session });
  if (!updated) throw insufficient(product.name);
  await writeLedger(session, { product, orderId, type: op === "commitDirect" ? "commit" : op, quantity: need, reservedAfter: updated.reserved, stockAfter: updated.stock });
}

async function eachLine(op, order, session) {
  const map = await aggregateNeeds(order.items);
  for (const entry of map.values()) await applyLine(op, entry, order.orderId, session);
  return map.size;
}

// Reserve stock for a freshly-created order. Idempotent via inventoryState.
async function reserveForOrder(order, session) {
  if (order.inventoryState !== "none") return;
  await eachLine("reserve", order, session);
  order.inventoryState = "reserved";
}

// Commit (settle) stock for a paid order. Handles both a live reservation and a
// previously-released order (re-checks availability). Idempotent.
async function commitForOrder(order, session) {
  if (order.inventoryState === "committed") return; // already settled
  if (order.inventoryState === "reserved") await eachLine("commit", order, session);
  else await eachLine("commitDirect", order, session); // released / none → availability-guarded
  order.inventoryState = "committed";
  order.stockDeducted = true;
}

// Release a held reservation (manual release / cancel / TTL expiry). Idempotent.
async function releaseForOrder(order, session) {
  if (order.inventoryState !== "reserved") return;
  await eachLine("release", order, session);
  order.inventoryState = "released";
}

// Restore stock for a refunded (previously committed) order. Idempotent.
async function refundForOrder(order, session) {
  if (order.inventoryState !== "committed") return;
  await eachLine("refund", order, session);
  order.inventoryState = "released";
}

module.exports = {
  findProductForItem, checkStockAvailability, deductStockForOrder,
  // Phase 3 engine
  withTxn, reserveForOrder, commitForOrder, releaseForOrder, refundForOrder, aggregateNeeds,
};
