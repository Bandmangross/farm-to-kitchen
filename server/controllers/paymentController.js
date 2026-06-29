const https = require("https");
const Order = require("../models/Order");
const Payment = require("../models/Payment");
const PaymentEvent = require("../models/PaymentEvent");
const logActivity = require("../utils/activity");
const { deductStockForOrder, withTxn, commitForOrder } = require("../utils/inventory");
const paystack = require("../utils/paystack");
const { sendOrderConfirmationEmail } = require("../utils/email");

const integrityOn = () => process.env.ENABLE_COMMERCE_INTEGRITY === "true"; // Phase 3 (default off)

async function logPaymentEvent(p) { try { await PaymentEvent.create(p); } catch (e) { console.warn("[PaymentEvent] " + e.message); } }

// Verify a transaction with Paystack using the SECRET key (server-side only).
function verifyWithPaystack(reference) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.paystack.co",
      path: "/transaction/verify/" + encodeURIComponent(reference),
      method: "GET",
      headers: { Authorization: "Bearer " + process.env.PAYSTACK_SECRET_KEY },
    };
    const request = https.request(options, (resp) => {
      let data = "";
      resp.on("data", (chunk) => (data += chunk));
      resp.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    request.on("error", reject);
    request.end();
  });
}

// POST /api/payments  { reference, orderId }
// Phase 3 (flag ON): mandatory gateway verify, server-authoritative amount check,
// idempotent transactional commit. Legacy behaviour preserved when the flag is off.
exports.confirm = async (req, res, next) => {
  if (integrityOn()) return exports.confirmSecure(req, res, next);
  try {
    const { reference, orderId } = req.body;
    console.log(`[Payment] Confirm requested — order: ${orderId}, ref: ${reference}`);
    if (!reference) return res.status(400).json({ message: "Payment reference is required" });

    const order = await Order.findOne({ orderId });
    if (!order) {
      console.warn(`[Payment] Order not found for confirm: ${orderId}`);
      return res.status(404).json({ message: "Order not found" });
    }

    let verified;
    // SECURITY: simulation is allowed ONLY when explicitly enabled via
    // ALLOW_SIMULATED_PAYMENTS (dev/test). It is NEVER inferred from a missing or
    // placeholder key — that inference was a free-order/payment bypass. In every
    // other case the charge MUST be verified with Paystack using the secret key.
    if (paystack.simulationAllowed() && String(reference).startsWith("SIMULATED-")) {
      verified = { status: true, data: { status: "success", amount: order.grandTotal * 100, channel: "simulated", currency: "NGN" } };
    } else {
      verified = await verifyWithPaystack(reference);
    }

    const pdata = verified && verified.data;
    if (!verified.status || !pdata || pdata.status !== "success") {
      return res.status(402).json({ message: "Payment not successful", detail: pdata && pdata.gateway_response });
    }

    // Confirm the amount matches what we expect (kobo → naira).
    if (Math.round(pdata.amount / 100) !== Math.round(order.grandTotal)) {
      return res.status(400).json({ message: "Paid amount does not match the order total" });
    }

    order.paymentStatus = "Paid";
    order.status = "Paid";
    order.transactionRef = reference;

    // Deduct inventory now that payment is confirmed (idempotent — skips if the
    // order was already deducted at creation).
    await deductStockForOrder(order);
    await order.save();

    const payment = await Payment.create({
      order: order._id, orderId: order.orderId, reference,
      amount: order.grandTotal, currency: pdata.currency || "NGN",
      channel: pdata.channel || "", status: "success",
      customerEmail: order.customerEmail, gatewayResponse: pdata, paidAt: new Date(),
    });

    await logActivity({ type: "payment", icon: "💳", message: `Payment received for ${order.orderId} (${reference})` });

    // Best-effort order-confirmation email — must NEVER block payment/order success.
    try {
      await sendOrderConfirmationEmail({
        to: order.customerEmail,
        data: { orderId: order.orderId, customerName: order.customerName, total: order.grandTotal, items: order.items },
      });
    } catch (e) { console.warn("[order-email] confirm send failed: " + e.message); }

    res.status(201).json({ order, payment });
  } catch (err) {
    next(err);
  }
};

// Phase 3 hardened confirm. Shared by POST /api/payments (flag on) and the webhook.
//   settle(order, gatewayData, { reference, source, req }) — does the verified,
//   idempotent, transactional settlement and returns { order, payment, alreadyPaid }.
async function settleOrder(order, pdata, { reference, source, req }) {
  // Idempotent: an already-paid order is a no-op (record a duplicate event).
  if (order.paymentStatus === "Paid" || order.inventoryState === "committed") {
    await logPaymentEvent({ order: order._id, orderId: order.orderId, reference, type: "duplicate", status: "success", source, ipAddress: req ? req.ip : "" });
    return { order, alreadyPaid: true };
  }

  // Server-authoritative amount (kobo) + currency check vs serverGrandTotal.
  const expected = Math.round(order.serverGrandTotal || order.grandTotal);
  const paidNaira = Math.round((pdata.amount || 0) / 100);
  const currencyOk = !pdata.currency || pdata.currency === (order.currency || "NGN");
  if (paidNaira !== expected || !currencyOk) {
    await logPaymentEvent({ order: order._id, orderId: order.orderId, reference, type: "mismatch", status: pdata.status || "", amount: paidNaira, currency: pdata.currency || "NGN", source, payload: { expected, currency: order.currency }, ipAddress: req ? req.ip : "" });
    const e = new Error("Paid amount/currency does not match the order."); e.status = 400; throw e;
  }

  const result = await withTxn(async (session) => {
    const fresh = await Order.findById(order._id).session(session);
    if (fresh.paymentStatus === "Paid" || fresh.inventoryState === "committed") return { order: fresh, alreadyPaid: true };
    await commitForOrder(fresh, session); // reserved/released → committed (idempotent)
    fresh.paymentStatus = "Paid"; fresh.status = "Paid"; fresh.transactionRef = reference;
    fresh.statusHistory.push({ from: "Awaiting Payment", to: "Paid", actor: "gateway", reason: source, at: new Date() });
    fresh.version = (fresh.version || 0) + 1;
    await fresh.save({ session });
    const [payment] = await Payment.create([{
      order: fresh._id, orderId: fresh.orderId, reference,
      amount: fresh.serverGrandTotal || fresh.grandTotal, currency: pdata.currency || "NGN",
      channel: pdata.channel || "", status: "success", customerEmail: fresh.customerEmail,
      gatewayResponse: pdata, paidAt: new Date(),
    }], { session });
    await PaymentEvent.create([{ order: fresh._id, orderId: fresh.orderId, reference, type: source === "webhook" ? "webhook" : "verified", status: "success", amount: payment.amount, currency: payment.currency, source, payload: pdata }], { session });
    return { order: fresh, payment, alreadyPaid: false };
  });
  return result;
}

exports.settleOrder = settleOrder;

exports.confirmSecure = async (req, res, next) => {
  try {
    const { reference, orderId } = req.body;
    if (!reference) return res.status(400).json({ message: "Payment reference is required" });
    const order = await Order.findOne({ orderId });
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.status === "Cancelled") return res.status(409).json({ message: "This order was cancelled." });

    // MANDATORY gateway verify. Simulation ONLY behind the dev flag (never inferred
    // from a missing/placeholder key → closes R3).
    let pdata;
    if (paystack.simulationAllowed() && String(reference).startsWith("SIMULATED-")) {
      pdata = { status: "success", amount: Math.round(order.serverGrandTotal || order.grandTotal) * 100, channel: "simulated", currency: order.currency || "NGN" };
    } else {
      const verified = await paystack.verifyTransaction(reference);
      pdata = verified && verified.data;
      if (!verified || !verified.status || !pdata || pdata.status !== "success") {
        await logPaymentEvent({ order: order._id, orderId: order.orderId, reference, type: "mismatch", status: pdata && pdata.status, source: "confirm", ipAddress: req.ip });
        return res.status(402).json({ message: "Payment not successful", detail: pdata && pdata.gateway_response });
      }
    }

    try {
      const out = await settleOrder(order, pdata, { reference, source: "confirm", req });
      if (out.alreadyPaid) return res.status(200).json({ order: out.order, alreadyPaid: true });
      await logActivity({ type: "payment", icon: "💳", message: `Payment received for ${order.orderId} (${reference})` });
      return res.status(201).json({ order: out.order, payment: out.payment });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ message: e.message });
      throw e;
    }
  } catch (err) { next(err); }
};

// POST /api/payments/webhook — Paystack signature-verified settlement (R10 safety net).
// Registered with a RAW body parser in server.js so the HMAC is computed over the
// exact bytes Paystack signed. Acks fast, then settles idempotently.
exports.webhook = async (req, res) => {
  if (process.env.ENABLE_PAYMENT_WEBHOOK !== "true") return res.status(404).end();
  const sig = req.headers["x-paystack-signature"];
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : JSON.stringify(req.body || {});
  if (!paystack.verifySignature(raw, sig)) return res.status(401).json({ message: "Invalid signature" });

  let evt; try { evt = JSON.parse(raw); } catch (_) { return res.status(400).end(); }

  // Settle BEFORE acknowledging. Settlement is a fast local transaction (no gateway
  // round-trip — the event already carries the verified data), so we complete it
  // and only then return 200. This guarantees processing and lets Paystack retry on
  // any 5xx. (Settling after the response risks the async work being torn down when
  // the request completes.)
  try {
    if (evt.event === "charge.success") {
      const data = evt.data || {};
      const reference = data.reference;
      const orderId = (data.metadata && data.metadata.orderId) || null;
      const order = orderId
        ? await Order.findOne({ orderId })
        : await Order.findOne({ transactionRef: reference });
      if (order && order.status !== "Cancelled") {
        await settleOrder(order, data, { reference, source: "webhook", req });
      } else {
        await logPaymentEvent({ orderId: orderId || "", reference, type: "webhook", status: "no_order", source: "webhook" });
      }
    }
    return res.sendStatus(200);
  } catch (e) {
    console.warn("[webhook] settle failed: " + e.message);
    return res.sendStatus(500); // Paystack will retry
  }
};

// GET /api/payments  (admin) — list all payments
exports.list = async (req, res, next) => {
  try {
    const payments = await Payment.find().sort({ createdAt: -1 });
    res.json(payments);
  } catch (err) {
    next(err);
  }
};
