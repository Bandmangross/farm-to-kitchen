const router = require("express").Router();
const { dashboard } = require("../controllers/analyticsController");
const { protect } = require("../middleware/auth");
const admin = require("../middleware/admin");

router.get("/", protect, admin, dashboard); // GET /api/analytics (admin)

module.exports = router;
