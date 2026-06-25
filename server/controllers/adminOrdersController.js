const Order = require("../models/Order");
const Payment = require("../models/Payment");
const PaymentEvent = require("../models/PaymentEvent");
const StockLedger = require("../models/StockLedger");
const logActivity = require("../utils/activity");
const { writeCommerceAudit } = require("../utils/commerceAudit");
const { withTxn, releaseForOrder } = require("../utils/inventory");
const { applyTransition } = require("../utils/orderState");
const paystack = require("../utils/paystack");

const ORDER_STATUSES = ["Awaiting Payment", "Paid", "Processing", "Shipped", "Delivered", "Cancelled", "Refunded"];
const snap = (o) => ({ status: o.status, paymentStatus: o.paymentStatus, inventoryState: o.inventoryState, version: o.version });

// Resolve :id as a Mongo _id OR the human FTK order id.
async function findOrder(id) {
  if (/^[0-9a-fA-F]{24}$/.test(id)) { const byId = await Order.findById(id); if (byId) return byId; }
  return Order.findOne({ orderId: id });
}

// GET /api/admin/orders?status=&orderId=&email=&page=&limit=
exports.listOrders = async (req, res, next) => {
  try {
    const { status, orderId, email } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const q = {};
    if (status && ORDER_STATUSES.includes(status)) q.status = status;
    if (req.query.paymentStatus) q.paymentStatus = req.query.paymentStatus;
    if (orderId) q.orderId = new RegExp("^" + String(orderId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    if (email) q.customerEmail = String(email).toLowerCase();

    const [items, total] = await Promise.all([
      Order.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      Order.countDocuments(q),
    ]);
    res.json({ orders: items, page, limit, total, pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
};

// GET /api/admin/orders/:id
exports.getOrder = async (req, res, next) => {
  try {
    const order = await findOrder(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });
    res.json(order);
  } catch (err) { next(err); }
};

// GET /api/admin/orders/:id/payments — payment timeline for an order.
exports.orderPayments = async (req, res, next) => {
  try {
    const order = await findOrder(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });
    const [events, payments] = await Promise.all([
      PaymentEvent.find({ orderId: order.orderId }).sort({ createdAt: 1 }),
      Payment.find({ orderId: order.orderId }).sort({ createdAt: 1 }),
    ]);
    res.json({ orderId: order.orderId, payments, events });
  } catch (err) { next(err); }
};

// GET /api/admin/orders/:id/inventory — stock movements for an order.
exports.orderInventory = async (req, res, next) => {
  try {
    const order = await findOrder(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });
    const movements = await StockLedger.find({ orderId: order.orderId }).sort({ createdAt: 1 });
    res.json({ orderId: order.orderId, movements });
  } catch (err) { next(err); }
};

// GET /api/admin/payments — global payment-event feed (paginated).
exports.listPayments = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const [events, total] = await Promise.all([
      PaymentEvent.find().sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      PaymentEvent.countDocuments(),
    ]);
    res.json({ events, page, limit, total, pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
};

// GET /api/admin/inventory?product= — global stock-movement feed (paginated).
exports.listInventory = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const q = {};
    if (req.query.product) q.product = req.query.product;
    const [movements, total] = await Promise.all([
      StockLedger.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      StockLedger.countDocuments(q),
    ]);
    res.json({ movements, page, limit, total, pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
};

// Shared transactional transition + audit for cancel/refund.
async function adminTransition(req, res, next, to, action) {
  try {
    const reason = (req.body && req.body.reason || "").trim();
    if (!reason) return res.status(400).json({ message: "A reason is required." });
    const found = await findOrder(req.params.id);
    if (!found) return res.status(404).json({ message: "Order not found" });
    const before = snap(found);

    let result;
    try {
      result = await withTxn(async (session) => {
        const order = await Order.findById(found._id).session(session);
        await applyTransition(order, to, { actor: "admin", actorId: req.user._id, reason }, session);
        await order.save({ session });
        return order;
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ message: e.message });
      if (e.code === "INSUFFICIENT_STOCK") return res.status(409).json({ message: e.message });
      throw e;
    }

    // Optional real gateway refund (decision 8) — behind ENABLE_GATEWAY_REFUND.
    let gateway = null;
    if (to === "Refunded" && process.env.ENABLE_GATEWAY_REFUND === "true" && result.transactionRef) {
      try {
        gateway = await paystack.refundTransaction(result.transactionRef, result.serverGrandTotal || result.grandTotal);
        await PaymentEvent.create({ order: result._id, orderId: result.orderId, reference: result.transactionRef, type: "refund", status: gateway && gateway.status ? "success" : "requested", amount: result.serverGrandTotal || result.grandTotal, source: "admin", payload: gateway || {} });
        await writeCommerceAudit({ admin: req.user._id, adminEmail: req.user.email, action: "gateway_refund", orderId: result.orderId, amount: result.serverGrandTotal || result.grandTotal, reason, req });
      } catch (e) { console.warn("[gateway_refund] " + e.message); }
    }

    await writeCommerceAudit({ admin: req.user._id, adminEmail: req.user.email, action, orderId: result.orderId, before, after: snap(result), amount: result.serverGrandTotal || result.grandTotal, reason, req });
    await logActivity({ type: "order", icon: to === "Refunded" ? "↩️" : "🚫", message: `Order ${result.orderId} ${to.toLowerCase()} by admin`, user: req.user._id });
    res.json({ order: result, gatewayRefund: gateway });
  } catch (err) { next(err); }
}

// POST /api/admin/orders/:id/cancel { reason }
exports.cancel = (req, res, next) => adminTransition(req, res, next, "Cancelled", "order_cancelled");
// POST /api/admin/orders/:id/refund { reason }
exports.refund = (req, res, next) => adminTransition(req, res, next, "Refunded", "order_refunded");

// POST /api/admin/orders/:id/release { reason } — manual reservation release.
// Decision 9: frees the reservation, order STAYS "Awaiting Payment", no cancellation.
exports.release = async (req, res, next) => {
  try {
    const reason = (req.body && req.body.reason || "").trim();
    if (!reason) return res.status(400).json({ message: "A reason is required." });
    const found = await findOrder(req.params.id);
    if (!found) return res.status(404).json({ message: "Order not found" });
    if (found.inventoryState !== "reserved") return res.status(409).json({ message: "No active reservation to release." });
    const before = snap(found);

    const result = await withTxn(async (session) => {
      const order = await Order.findById(found._id).session(session);
      await releaseForOrder(order, session); // → inventoryState "released"; status unchanged
      order.statusHistory.push({ from: order.status, to: order.status, actor: "admin", actorId: req.user._id, reason: "manual release: " + reason, at: new Date() });
      order.version = (order.version || 0) + 1;
      await order.save({ session });
      return order;
    });

    await writeCommerceAudit({ admin: req.user._id, adminEmail: req.user.email, action: "reservation_released", orderId: result.orderId, before, after: snap(result), reason, req });
    res.json({ order: result });
  } catch (err) { next(err); }
};
