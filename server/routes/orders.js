const router = require("express").Router();
const ctrl = require("../controllers/orderController");
const { protect, optionalAuth } = require("../middleware/auth");
const admin = require("../middleware/admin");
const requireVerified = require("../middleware/requireVerified");

router.get("/my", protect, ctrl.myOrders);         // customer → ONLY their own orders
router.get("/", protect, admin, ctrl.list);        // admin → ALL orders (admin only)
router.post("/", optionalAuth, requireVerified, ctrl.create); // gate is a no-op until ENABLE_ORDER_VERIFICATION_GATE=true
router.put("/:id/status", protect, admin, ctrl.updateStatus);

module.exports = router;
