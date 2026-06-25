const crypto = require("crypto");
const { UAParser } = require("ua-parser-js");
const Device = require("../models/Device");
const geoip = require("./geoip");
const { baseCookie } = require("./tokens");

const DEVICE_COOKIE = "ftk_device";
const DEVICE_TTL_MS = 400 * 24 * 60 * 60 * 1000; // ~400 days
const trackingOn = () => process.env.ENABLE_DEVICE_TRACKING !== "false";

// Read the device UUID from its HttpOnly cookie, or issue a new one (server-side UUID,
// NO fingerprinting). Returns the deviceId string.
function getOrIssueDeviceId(req, res) {
  let id = req.cookies && req.cookies[DEVICE_COOKIE];
  if (!id) {
    id = crypto.randomUUID();
    res.cookie(DEVICE_COOKIE, id, Object.assign({}, baseCookie, { maxAge: DEVICE_TTL_MS }));
  }
  return id;
}

function parseUA(uaString) {
  try {
    const r = new UAParser(uaString || "").getResult();
    const browser = [r.browser.name, r.browser.version].filter(Boolean).join(" ");
    const os = [r.os.name, r.os.version].filter(Boolean).join(" ");
    return { browser, os };
  } catch (_) { return { browser: "", os: "" }; }
}

// Upsert the (user, device) record on login. Idempotent: same browser → updates
// lastSeenAt; new browser → new device row.
async function recordDevice(userId, deviceId, req) {
  if (!trackingOn() || !deviceId) return null;
  const ua = req.headers["user-agent"] || "";
  const { browser, os } = parseUA(ua);
  const now = new Date();
  const doc = await Device.findOneAndUpdate(
    { user: userId, deviceId },
    {
      $set: { browser, os, ipAddress: req.ip, userAgent: ua, lastSeenAt: now, revokedAt: null },
      $setOnInsert: { firstSeenAt: now },
    },
    { upsert: true, new: true }
  );
  return doc;
}

// Phase 2.6 — CUSTOMER login device handling with anomaly detection. Reads the prior
// state BEFORE upserting so it can report whether this is a new device or a new
// approximate location, then stamps coarse geo + lastLoginAt. Returns flags the caller
// uses to decide whether to send a login-anomaly alert. (Admin login is unaffected —
// it uses its own session path and never calls this.)
async function loginDevice(userId, deviceId, req) {
  if (!trackingOn() || !deviceId) return { device: null, isNewDevice: false, isNewLocation: false, geo: { city: "", country: "" } };
  const ua = req.headers["user-agent"] || "";
  const { browser, os } = parseUA(ua);
  const geo = geoip.lookup(req.ip);
  const now = new Date();

  const existing = await Device.findOne({ user: userId, deviceId });
  const isNewDevice = !existing || !!existing.revokedAt;
  // New location only flags for a KNOWN active device whose coarse country/city changed
  // (and only when we actually resolved a country — never alert on Unknown→Unknown).
  const isNewLocation = !!existing && !existing.revokedAt && !!geo.country &&
    (existing.approxCountry !== geo.country || (existing.approxCity || "") !== (geo.city || ""));

  const doc = await Device.findOneAndUpdate(
    { user: userId, deviceId },
    {
      $set: {
        browser, os, ipAddress: req.ip, userAgent: ua,
        lastSeenAt: now, lastLoginAt: now,
        approxCity: geo.city, approxCountry: geo.country,
        revokedAt: null,
      },
      $setOnInsert: { firstSeenAt: now },
    },
    { upsert: true, new: true }
  );
  return { device: doc, isNewDevice, isNewLocation, geo };
}

module.exports = { getOrIssueDeviceId, recordDevice, loginDevice, parseUA, DEVICE_COOKIE, DEVICE_TTL_MS };
