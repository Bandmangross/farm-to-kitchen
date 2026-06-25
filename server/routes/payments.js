const router = require("express").Router();
const ctrl = require("../controllers/paymentController");
const { protect, optionalAuth } = require("../middleware/auth");
const admin = require("../middleware/admin");

router.post("/", optionalAuth, ctrl.confirm); // verify a Paystack charge & settle the order
router.get("/", protect, admin, ctrl.list);   // admin → all payments

module.exports = router;
