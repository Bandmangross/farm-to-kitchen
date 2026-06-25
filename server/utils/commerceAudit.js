const CommerceAuditLog = require("../models/CommerceAuditLog");

// Best-effort writer for admin commerce actions (decision 10). An audit failure
// must never break the action it records. NEVER pass secrets/tokens in before/after.
async function writeCommerceAudit({ admin = null, adminEmail = "", action, orderId = "", before = {}, after = {}, amount, reason = "", success = true, req = null, session = null }) {
  try {
    const doc = {
      admin: admin || null,
      adminEmail: (adminEmail || "").toLowerCase(),
      action,
      orderId,
      before: before || {},
      after: after || {},
      amount,
      reason,
      success,
      ipAddress: req ? req.ip : "",
    };
    if (session) await CommerceAuditLog.create([doc], { session });
    else await CommerceAuditLog.create(doc);
  } catch (e) {
    console.warn("[CommerceAudit] failed to write " + action + ": " + e.message);
  }
}

module.exports = { writeCommerceAudit };
