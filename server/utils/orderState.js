const { releaseForOrder, refundForOrder } = require("./inventory");

// Phase 3 — single authoritative order lifecycle (decision 6). Allowed transitions
// only; anything else is rejected (409). Payment-driven transitions (→ Paid) happen
// ONLY through verified settlement, never via admin status edits, so an admin can't
// mark an order Paid without a real charge.
//
//   Awaiting Payment ─cancel→ Cancelled        (release reservation)
//   Paid ─→ Processing ─→ Shipped ─→ Delivered (fulfilment)
//   Paid|Processing|Shipped|Delivered ─refund→ Refunded   (restore stock)
const ALLOWED = {
  "Awaiting Payment": ["Cancelled"],
  "Paid": ["Processing", "Shipped", "Delivered", "Refunded"],
  "Processing": ["Shipped", "Delivered", "Refunded"],
  "Shipped": ["Delivered", "Refunded"],
  "Delivered": ["Refunded"],
  "Cancelled": [],
  "Refunded": [],
};

function canTransition(from, to) {
  return Array.isArray(ALLOWED[from]) && ALLOWED[from].includes(to);
}

// Mutate `order` for a validated transition, applying the matching inventory effect
// inside the caller's transaction `session`. Caller persists the order. Throws a
// {status:409} error on an illegal transition.
async function applyTransition(order, to, { actor = "admin", actorId = null, reason = "" } = {}, session) {
  const from = order.status;
  if (from === to) { const e = new Error(`Order is already ${to}.`); e.status = 409; throw e; }
  if (!canTransition(from, to)) { const e = new Error(`Cannot change order from "${from}" to "${to}".`); e.status = 409; throw e; }

  if (to === "Cancelled") {
    await releaseForOrder(order, session);     // frees a held reservation (no-op otherwise)
    order.paymentStatus = "Unpaid";
  } else if (to === "Refunded") {
    await refundForOrder(order, session);      // restores committed stock (no-op otherwise)
    order.paymentStatus = "Refunded";
  }

  order.status = to;
  order.statusHistory.push({ from, to, actor, actorId, reason, at: new Date() });
  order.version = (order.version || 0) + 1;
}

module.exports = { ALLOWED, canTransition, applyTransition };
