const router = require("express").Router();
const ctrl = require("../controllers/adminOrdersController");
const { protect } = require("../middleware/auth");
const admin = require("../middleware/admin");
const { apiLimiter } = require("../middleware/rateLimit");

// Phase 3 — Admin Orders Dashboard (decision 11: dedicated /api/admin namespace).
// Flag-gated: 404 when ENABLE_ADMIN_ORDERS_DASHBOARD is off. Every route runs behind
// protect → admin, so an MFA-enrolled admin still cannot reach it without MFA
// (Phase 2.5 lock reused, not modified).
const dashboardOn = (req, res, next) =>
  process.env.ENABLE_ADMIN_ORDERS_DASHBOARD === "true" ? next() : res.status(404).json({ message: "Admin orders dashboard is not enabled." });

router.use(apiLimiter, dashboardOn, protect, admin);

// Reads
router.get("/orders", ctrl.listOrders);
router.get("/orders/:id", ctrl.getOrder);
router.get("/orders/:id/payments", ctrl.orderPayments);
router.get("/orders/:id/inventory", ctrl.orderInventory);
router.get("/payments", ctrl.listPayments);
router.get("/inventory", ctrl.listInventory);

// Actions (each requires a reason; each writes a CommerceAuditLog entry)
router.post("/orders/:id/cancel", ctrl.cancel);
router.post("/orders/:id/refund", ctrl.refund);
router.post("/orders/:id/release", ctrl.release);

module.exports = router;
