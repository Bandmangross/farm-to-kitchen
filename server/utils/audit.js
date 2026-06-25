const AuthAuditLog = require("../models/AuthAuditLog");

const auditOn = () => process.env.ENABLE_AUDIT !== "false";

// Write a security-audit entry. NEVER pass passwords/tokens/OTPs in metadata.
// Best-effort: an audit failure must never break the auth request.
async function writeAuthAudit({ user = null, email = "", event, success = true, req = null, deviceId = "", metadata = {} }) {
  if (!auditOn()) return;
  try {
    await AuthAuditLog.create({
      user: user || null,
      email: (email || "").toLowerCase(),
      event,
      success,
      ipAddress: req ? req.ip : "",
      userAgent: req ? (req.headers["user-agent"] || "") : "",
      deviceId: deviceId || "",
      metadata: metadata || {},
    });
  } catch (e) {
    console.warn("[Audit] failed to write " + event + ": " + e.message);
  }
}

module.exports = { writeAuthAudit };
