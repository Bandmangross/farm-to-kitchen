const ActivityLog = require("../models/ActivityLog");

// Fire-and-forget activity logging. Never throws into the request flow.
async function logActivity({ type = "general", icon = "•", message, user = null, meta = null }) {
  try {
    await ActivityLog.create({ type, icon, message, user, meta });
  } catch (err) {
    console.error("activity log failed:", err.message);
  }
}

module.exports = logActivity;
