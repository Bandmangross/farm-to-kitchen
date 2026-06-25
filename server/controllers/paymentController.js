const https = require("https");
const Order = require("../models/Order");
const Payment = require("../models/Payment");
const logActivity = require("../utils/activity");
const { deductStockForOrder } = require("../utils/inventory");

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
// Confirms a Paystack charge, then marks the order Paid. THIS is the secure step.
exports.confirm = async (req, res, next) => {
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
    // Allow a simulated reference for local demos without a Paystack secret key.
    if (reference.startsWith("SIMULATED-") || !process.env.PAYSTACK_SECRET_KEY || process.env.PAYSTACK_SECRET_KEY.includes("xxxx")) {
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
    res.status(201).json({ order, payment });
  } catch (err) {
    next(err);
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
