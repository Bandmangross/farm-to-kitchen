const Order = require("../models/Order");
const logActivity = require("../utils/activity");
const { checkStockAvailability, deductStockForOrder } = require("../utils/inventory");

// FTK-2026-000001 — sequential per year.
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

// POST /api/orders  (guest or logged-in) — creates an "Awaiting Payment" order
exports.create = async (req, res, next) => {
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

// PUT /api/orders/:id/status  (admin) — also settles payment when appropriate
exports.updateStatus = async (req, res, next) => {
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

module.exports.genOrderId = genOrderId;
