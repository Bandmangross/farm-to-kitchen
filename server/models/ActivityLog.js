const mongoose = require("mongoose");

const activityLogSchema = new mongoose.Schema(
  {
    type: { type: String, default: "general" }, // order | product | stock | auth | payment
    icon: { type: String, default: "•" },
    message: { type: String, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    meta: { type: Object },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ActivityLog", activityLogSchema);
