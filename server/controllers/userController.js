const User = require("../models/User");

// GET /api/users  (admin only) — list all customers/admins
exports.listUsers = async (req, res, next) => {
  try {
    const users = await User.find().sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    next(err);
  }
};
