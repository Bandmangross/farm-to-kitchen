const router = require("express").Router();
const { listUsers } = require("../controllers/userController");
const { protect } = require("../middleware/auth");
const admin = require("../middleware/admin");

router.get("/", protect, admin, listUsers); // GET /api/users (admin)

module.exports = router;
