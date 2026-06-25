const Order = require("../models/Order");
const { withTxn, releaseForOrder } = require("../utils/inventory");

// Phase 3 — release stock held by orders whose reservation TTL has lapsed.
// Decision 9: the order STAYS "Awaiting Payment" (no auto-cancellation); only the
// reservation is freed so abandoned carts don't lock inventory.
async function sweepOnce() {
  if (process.env.ENABLE_COMMERCE_INTEGRITY !== "true") return 0;
  const now = new Date();
  const stuck = await Order.find({
    inventoryState: "reserved",
    paymentStatus: "Awaiting Payment",
    reservationExpiresAt: { $lt: now },
  }).limit(100);

  let n = 0;
  for (const o of stuck) {
    try {
      await withTxn(async (session) => {
        const fresh = await Order.findById(o._id).session(session);
        if (!fresh || fresh.inventoryState !== "reserved") return;
        await releaseForOrder(fresh, session); // → inventoryState "released", order still Awaiting Payment
        fresh.statusHistory.push({ from: "Awaiting Payment", to: "Awaiting Payment", actor: "system", reason: "reservation expired", at: new Date() });
        await fresh.save({ session });
      });
      n++;
    } catch (e) { console.warn("[sweeper] " + o.orderId + ": " + e.message); }
  }
  if (n) console.log(`[sweeper] released ${n} expired reservation(s)`);
  return n;
}

function start() {
  const ms = Number(process.env.RESERVATION_SWEEP_INTERVAL_MS || 60000);
  const t = setInterval(() => sweepOnce().catch((e) => console.warn("[sweeper] " + e.message)), ms);
  if (t.unref) t.unref();
  return t;
}

module.exports = { sweepOnce, start };
