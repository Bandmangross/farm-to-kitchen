const Order = require("../models/Order");
const Product = require("../models/Product");
const Counter = require("../models/Counter");
const logActivity = require("../utils/activity");
const { checkStockAvailability, deductStockForOrder, withTxn, reserveForOrder } = require("../utils/inventory");
const { applyTransition } = require("../utils/orderState");

const integrityOn = () => process.env.ENABLE_COMMERCE_INTEGRITY === "true"; // Phase 3 (default off)
const RESERVATION_TTL_MIN = Number(process.env.RESERVATION_TTL_MIN || 30);
const DEFAULT_DELIVERY_FEE = Number(process.env.DEFAULT_DELIVERY_FEE || 3000);

// FTK-2026-000001 — legacy sequential generator (flag-off path).
async function genOrderId() {
  const year = new Date().getFullYear();
  const prefix = `FTK-${year}-`;
  const last = await Order.findOne({ orderId: new RegExp("^" + prefix) }).sort({ orderId: -1 });
  let n = 0;
  if (last) {
    const m = /(\d+)$/.exec(last.orderId);
    if (m) n = parseInt(m[1], 10);
  }
  return prefix + String(n + 1).padStart(6, "0");
}

// Atomic, gap-free order ID (flag-on path) — fixes the genOrderId race (R8).
async function nextOrderId(session) {
  const year = new Date().getFullYear();
  const seq = await Counter.nextSeq("order-" + year, session);
  return `FTK-${year}-${String(seq).padStart(6, "0")}`;
}

// SERVER-AUTHORITATIVE re-pricing (decision 1). Resolves every line against the DB,
// rejecting unknown/inactive products and unmatched variants; client price/total are
// IGNORED. Returns { lines, serverTotal } or throws a 400-style error.
async function repriceLines(items) {
  const lines = [];
  let serverTotal = 0;
  for (const it of items) {
    const product = it.product ? await Product.findById(it.product).catch(() => null) : await Product.findOne({ name: (it.name || "").trim() });
    if (!product) { const e = new Error(`Product not found: ${it.name || it.product}`); e.status = 400; throw e; }
    if (product.status && product.status !== "active") { const e = new Error(`${product.name} is not available for purchase.`); e.status = 409; throw e; }

    const hasVariants = Array.isArray(product.variants) && product.variants.length > 0;
    const wantLabel = String(it.variantLabel || it.quantity || "").trim().toLowerCase();
    let unitPrice, variantLabel = "", qty;
    if (hasVariants) {
      const v = product.variants.find((x) => String(x.label).trim().toLowerCase() === wantLabel);
      if (!v) { const e = new Error(`Select a valid option for ${product.name}.`); e.status = 400; throw e; }
      unitPrice = v.price; variantLabel = v.label;
      qty = Number(it.qty) || Number(it.units) || parseInt(it.quantity, 10) || 1;
    } else {
      unitPrice = product.price;
      qty = Number(it.qty) || Number(it.units) || parseInt(it.quantity, 10) || 1;
    }
    const lineTotal = Math.round(unitPrice * qty);
    serverTotal += lineTotal;
    lines.push({
      product: product._id, name: product.name,
      quantity: String(it.quantity || variantLabel || qty), variantLabel,
      units: qty, qty, unitPrice, lineTotal, price: lineTotal,
    });
  }
  return { lines, serverTotal };
}

// GET /api/orders  (admin only) — ALL orders.
exports.list = async (req, res, next) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    next(err);
  }
};

// GET /api/orders/my — ONLY the authenticated customer's own orders, for ANY role.
// Scoped strictly to this user's email/id so no one ever sees another customer's data.
exports.myOrders = async (req, res, next) => {
  try {
    const email = (req.user.email || "").toLowerCase();
    const orders = await Order.find({
      $or: [{ customerEmail: email }, { user: req.user._id }],
    }).sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    next(err);
  }
};

// POST /api/orders  (guest or logged-in) — creates an "Awaiting Payment" order.
// Phase 3 (flag ON): server-authoritative pricing + stock reservation, in one
// transaction; client price/total/paid-state are ignored.
exports.create = async (req, res, next) => {
  if (integrityOn()) return exports.createSecure(req, res, next);
  try {
    const { customerName, customerEmail, customerPhone, customerAddress, items, deliveryFee = 3000, paymentMethod = "Paystack" } = req.body;
    if (!customerName || !customerEmail || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "Customer details and at least one item are required" });
    }

    // Normalise items + compute totals server-side (never trust client totals).
    const normalised = [];
    let total = 0;
    for (const it of items) {
      const name = (it.name || "").trim();
      const units = Number(it.units) || parseInt(it.quantity, 10) || 1;
      const price = Number(it.price) || 0;
      // Store the selected variant EXPLICITLY (req 6). Falls back to the display
      // label so inventory can still resolve legacy/no-variant lines.
      const variantLabel = String(it.variantLabel || it.quantity || "").trim();
      normalised.push({ product: it.product, name, quantity: String(it.quantity || units), variantLabel, units, price });
      total += price;
    }

    // Requirement 4: reject the order up-front if any product is short on stock.
    const availability = await checkStockAvailability(normalised);
    if (!availability.ok) {
      return res.status(409).json({ message: availability.message });
    }

    // An order is "paid" if the client/payment flow marks it so on creation
    // (e.g. Pay-on-Delivery confirmed, or an admin-created paid order).
    const isPaid = req.body.paymentStatus === "Paid" || req.body.status === "Paid";

    const grandTotal = total + Number(deliveryFee);
    const order = await Order.create({
      orderId: await genOrderId(),
      user: req.user ? req.user._id : null,
      customerName, customerEmail, customerPhone, customerAddress,
      items: normalised,
      quantity: normalised.length,
      total, deliveryFee: Number(deliveryFee), grandTotal, amount: grandTotal,
      paymentMethod,
      paymentStatus: isPaid ? "Paid" : "Awaiting Payment",
      status: isPaid ? "Paid" : "Awaiting Payment",
      transactionRef: req.body.transactionRef || null,
      date: new Date().toLocaleString(),
    });

    // Requirement 2: deduct stock ONLY when the order is paid. Awaiting-payment
    // orders deduct later, in the Paystack confirm step (paymentController).
    if (isPaid) {
      await deductStockForOrder(order);
      await order.save(); // persist the stockDeducted flag
    }

    await logActivity({ type: "order", icon: "🛒", message: `New order ${order.orderId} by ${order.customerName}` });
    res.status(201).json(order);
  } catch (err) {
    next(err);
  }
};

// Phase 3 hardened create. Server re-prices, reserves stock, always Awaiting Payment.
exports.createSecure = async (req, res, next) => {
  try {
    const { customerName, customerEmail, customerPhone, customerAddress, items, paymentMethod = "Paystack" } = req.body;
    if (!customerName || !customerEmail || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "Customer details and at least one item are required" });
    }

    // Idempotent create: same key → return the existing order (no duplicate/charge).
    const idempotencyKey = req.headers["idempotency-key"] || req.body.idempotencyKey || null;
    if (idempotencyKey) {
      const existing = await Order.findOne({ idempotencyKey });
      if (existing) return res.status(200).json(existing);
    }

    // Re-price from the DB (ignore any client price/total/paid-state).
    let priced;
    try { priced = await repriceLines(items); }
    catch (e) { return res.status(e.status || 400).json({ message: e.message }); }

    const deliveryFee = DEFAULT_DELIVERY_FEE;
    const grandTotal = priced.serverTotal + deliveryFee;

    try {
      const order = await withTxn(async (session) => {
        const orderId = await nextOrderId(session);
        const now = new Date();
        const [created] = await Order.create([{
          orderId,
          user: req.user ? req.user._id : null,
          customerName, customerEmail, customerPhone, customerAddress,
          items: priced.lines,
          quantity: priced.lines.length,
          total: priced.serverTotal, deliveryFee, grandTotal, amount: grandTotal,
          currency: "NGN", serverTotal: priced.serverTotal, serverGrandTotal: grandTotal,
          idempotencyKey: idempotencyKey || undefined,
          paymentMethod,
          paymentStatus: "Awaiting Payment", status: "Awaiting Payment", // client-declared paid IGNORED
          inventoryState: "none",
          reservationExpiresAt: new Date(now.getTime() + RESERVATION_TTL_MIN * 60 * 1000),
          statusHistory: [{ from: "", to: "Awaiting Payment", actor: "customer", reason: "order created", at: now }],
          date: now.toLocaleString(),
        }], { session });

        await reserveForOrder(created, session); // sets inventoryState = "reserved"
        await created.save({ session });
        return created;
      });

      await logActivity({ type: "order", icon: "🛒", message: `New order ${order.orderId} by ${order.customerName}` });
      return res.status(201).json(order);
    } catch (e) {
      if (e.code === "INSUFFICIENT_STOCK") return res.status(409).json({ message: e.message });
      throw e;
    }
  } catch (err) {
    next(err);
  }
};

// PUT /api/orders/:id/status  (admin) — also settles payment when appropriate
exports.updateStatus = async (req, res, next) => {
  if (integrityOn()) return exports.updateStatusSecure(req, res, next);
  try {
    const { status } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    order.status = status;
    if (status === "Paid" || status === "Delivered") {
      order.paymentStatus = "Paid";
      if (!order.transactionRef) order.transactionRef = "ADMIN-CONFIRMED";
      // Settling an unpaid (e.g. Pay-on-Delivery) order now deducts its stock.
      // Idempotent — does nothing if the order was already deducted.
      await deductStockForOrder(order);
    } else if (status === "Awaiting Payment") {
      order.paymentStatus = "Awaiting Payment";
    }
    await order.save();

    await logActivity({ type: "order", icon: "🔧", message: `Order ${order.orderId} marked ${status}`, user: req.user._id });
    res.json(order);
  } catch (err) {
    next(err);
  }
};

// Phase 3 hardened status update — state-machine validated, transactional, audited
// via statusHistory. Payment (→ Paid) is NOT reachable here (only verified settlement).
exports.updateStatusSecure = async (req, res, next) => {
  try {
    const { status, reason } = req.body;
    const found = await Order.findById(req.params.id);
    if (!found) return res.status(404).json({ message: "Order not found" });

    let result;
    try {
      result = await withTxn(async (session) => {
        const order = await Order.findById(req.params.id).session(session);
        await applyTransition(order, status, { actor: "admin", actorId: req.user._id, reason: reason || "" }, session);
        await order.save({ session });
        return order;
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ message: e.message });
      if (e.code === "INSUFFICIENT_STOCK") return res.status(409).json({ message: e.message });
      throw e;
    }

    await logActivity({ type: "order", icon: "🔧", message: `Order ${result.orderId} → ${status}`, user: req.user._id });
    res.json(result);
  } catch (err) { next(err); }
};

module.exports.genOrderId = genOrderId;
