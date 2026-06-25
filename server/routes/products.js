const router = require("express").Router();
const ctrl = require("../controllers/productController");
const { protect } = require("../middleware/auth");
const admin = require("../middleware/admin");

router.get("/", ctrl.list); // public storefront
router.post("/", protect, admin, ctrl.create);
router.put("/:id", protect, admin, ctrl.update);
router.delete("/:id", protect, admin, ctrl.remove);

module.exports = router;
