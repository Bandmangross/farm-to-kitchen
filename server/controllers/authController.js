const User = require("../models/User");
const Session = require("../models/Session");
const Device = require("../models/Device");
const logActivity = require("../utils/activity");
const { writeAuthAudit } = require("../utils/audit");
const { recordDevice, loginDevice, getOrIssueDeviceId } = require("../utils/device");
const geoip = require("../utils/geoip");
const { normalizeEmail, sendNewDeviceLoginEmail } = require("../utils/email");
const { issueVerification, verificationEnabled } = require("../utils/emailVerify");
const {
  signAccess, newRefreshToken, hashToken,
  setRefreshCookie, clearRefreshCookie, REFRESH_COOKIE, REFRESH_TTL_MS,
} = require("../utils/tokens");

const MAX_FAILED = Number(process.env.MAX_FAILED_LOGINS || 5);
const LOCK_MS = Number(process.env.LOGIN_LOCK_MS || 15 * 60 * 1000);
const lockoutOn = () => process.env.ENABLE_LOCKOUT !== "false";
const refreshOn = () => process.env.ENABLE_REFRESH_TOKENS !== "false";
const loginAlertsOn = () => process.env.ENABLE_LOGIN_ALERTS === "true"; // Phase 2.6 (default off)
const sessionUiOn = () => process.env.ENABLE_SESSION_UI === "true";     // Phase 2.6 (default off)

function publicUser(u) {
  return {
    id: u._id, fullName: u.fullName, email: u.email, phone: u.phone, address: u.address,
    role: u.role, joinDate: u.joinDate,
    accountStatus: u.accountStatus, emailVerified: u.emailVerified, phoneVerified: u.phoneVerified,
    verifiedAt: u.verifiedAt,
  };
}

// Issue an access token, record the device, and (if enabled) open a refresh session.
// opts.deviceId / opts.device let the login path pass an already-recorded device
// (from loginDevice's anomaly check) so we don't upsert it twice.
async function startSession(user, req, res, opts = {}) {
  const deviceId = opts.deviceId || getOrIssueDeviceId(req, res);
  const device = opts.device !== undefined ? opts.device : await recordDevice(user._id, deviceId, req);
  if (refreshOn()) {
    const raw = newRefreshToken();
    await Session.create({
      user: user._id,
      device: device ? device._id : null,
      refreshTokenHash: hashToken(raw),
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"] || "",
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    });
    setRefreshCookie(res, raw);
  }
  return { accessToken: signAccess(user), deviceId };
}

// POST /api/register — new accounts start as pending_verification.
exports.register = async (req, res, next) => {
  try {
    const { fullName, email, phone, password } = req.body;
    if (!fullName || !email || !password) {
      return res.status(400).json({ message: "Full name, email and password are required" });
    }
    const emailOriginal = email.trim();
    const emailNormalized = normalizeEmail(email);
    // Uniqueness is enforced on the NORMALIZED form (dedup gmail dots/+tags etc.).
    const exists = await User.findOne({ emailNormalized });
    if (exists) return res.status(409).json({ message: "An account with this email already exists" });

    const user = await User.create({
      fullName, email: emailOriginal.toLowerCase(), emailOriginal, emailNormalized, phone, password,
    }); // status → pending_verification
    await logActivity({ type: "auth", icon: "🆕", message: `New account: ${user.email}`, user: user._id });

    // Auto-send the verification email (when the feature flag is on). Never fail
    // registration if email delivery hiccups.
    let dev = null;
    if (verificationEnabled()) {
      try {
        const out = await issueVerification(user, req);
        if (process.env.EMAIL_DEV_ECHO === "true") dev = { devLink: out.link, devCode: out.code };
      } catch (e) { console.warn("[register] verification email failed: " + e.message); }
    }

    const { accessToken } = await startSession(user, req, res);
    const payload = { token: accessToken, user: publicUser(user) };
    if (dev) Object.assign(payload, dev);
    res.status(201).json(payload);
  } catch (err) { next(err); }
};

// POST /api/login — rate-limited (route) + lockout + device + session + audit.
exports.login = async (req, res, next) => {
  try {
    const emailLc = (req.body.email || "").toLowerCase();
    const user = await User.findOne({ emailNormalized: normalizeEmail(req.body.email) }).select("+password");
    // Admins must authenticate via the admin portal (MFA). Customer login is unchanged.
    if (user && user.role === "admin") {
      return res.status(403).json({ message: "Admin accounts must sign in via the admin portal." });
    }
    if (!user) {
      await writeAuthAudit({ email: emailLc, event: "login", success: false, req, metadata: { reason: "no_user" } });
      return res.status(401).json({ message: "Invalid email or password" });
    }
    if (["deleted", "suspended"].includes(user.accountStatus)) {
      await writeAuthAudit({ user: user._id, email: emailLc, event: "login", success: false, req, metadata: { reason: user.accountStatus } });
      return res.status(403).json({ message: "This account is " + user.accountStatus + "." });
    }
    if (lockoutOn() && user.lockUntil && user.lockUntil > new Date()) {
      await writeAuthAudit({ user: user._id, email: emailLc, event: "login", success: false, req, metadata: { reason: "locked" } });
      const mins = Math.ceil((user.lockUntil - Date.now()) / 60000);
      return res.status(429).json({ message: "Account temporarily locked. Try again in " + mins + " min." });
    }

    const ok = await user.comparePassword(req.body.password);
    if (!ok) {
      if (lockoutOn()) {
        user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
        if (user.failedLoginAttempts >= MAX_FAILED) {
          user.lockUntil = new Date(Date.now() + LOCK_MS);
          user.failedLoginAttempts = 0; // fresh attempts after the lock expires
        }
        await user.save();
      }
      await writeAuthAudit({ user: user._id, email: emailLc, event: "login", success: false, req, metadata: { reason: "bad_password" } });
      return res.status(401).json({ message: "Invalid email or password" });
    }

    user.failedLoginAttempts = 0; user.lockUntil = null;
    user.lastLoginAt = new Date(); user.lastLoginIp = req.ip;
    await user.save();

    // Phase 2.6: detect new device / new approximate location BEFORE the session record
    // is upserted, then reuse that device for the session (no double upsert).
    const deviceId = getOrIssueDeviceId(req, res);
    const { device, isNewDevice, isNewLocation, geo } = await loginDevice(user._id, deviceId, req);
    const { accessToken } = await startSession(user, req, res, { deviceId, device });
    await writeAuthAudit({ user: user._id, email: emailLc, event: "login", success: true, req, deviceId });

    // Best-effort login-anomaly alert (flag-gated). Never breaks login.
    if ((isNewDevice || isNewLocation) && loginAlertsOn()) {
      const reason = isNewDevice ? "New device" : "New location";
      await writeAuthAudit({ user: user._id, email: emailLc, event: "new_device_login", success: true, req, deviceId, metadata: { reason, location: geoip.label(geo) } });
      try {
        await sendNewDeviceLoginEmail({
          to: user.emailOriginal || user.email,
          lang: user.language || "en",
          data: {
            when: new Date().toUTCString(),
            device: [device && device.browser, device && device.os].filter(Boolean).join(" · ") || "Unknown device",
            location: geoip.label(geo),
            ip: req.ip,
            reason,
          },
        });
      } catch (e) { console.warn("[login-alert] send failed: " + e.message); }
    }

    res.json({ token: accessToken, user: publicUser(user) });
  } catch (err) { next(err); }
};

// POST /api/auth/token/refresh — rotates the refresh token, returns a fresh access token.
exports.refresh = async (req, res, next) => {
  try {
    if (!refreshOn()) return res.status(404).json({ message: "Refresh not enabled" });
    const raw = req.cookies && req.cookies[REFRESH_COOKIE];
    if (!raw) return res.status(401).json({ message: "No refresh token" });

    const session = await Session.findOne({ refreshTokenHash: hashToken(raw), revokedAt: null });
    if (!session || session.expiresAt < new Date()) {
      clearRefreshCookie(res);
      return res.status(401).json({ message: "Refresh token invalid or expired" });
    }
    const user = await User.findById(session.user);
    if (!user || ["deleted", "suspended", "locked"].includes(user.accountStatus)) {
      clearRefreshCookie(res);
      return res.status(401).json({ message: "Session no longer valid" });
    }

    // Rotate: revoke the used token, mint a successor.
    const newRaw = newRefreshToken();
    session.revokedAt = new Date();
    session.rotatedTo = hashToken(newRaw);
    await session.save();
    await Session.create({
      user: user._id, device: session.device,
      refreshTokenHash: hashToken(newRaw),
      ipAddress: req.ip, userAgent: req.headers["user-agent"] || "",
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    });
    setRefreshCookie(res, newRaw);
    res.json({ token: signAccess(user), user: publicUser(user) });
  } catch (err) { next(err); }
};

// POST /api/logout — revoke the current session (refresh cookie) + audit.
exports.logout = async (req, res) => {
  try {
    const raw = req.cookies && req.cookies[REFRESH_COOKIE];
    let userId = req.user ? req.user._id : null;
    let email = req.user ? req.user.email : "";
    if (raw) {
      const hash = hashToken(raw);
      // Attribute the logout to the cookie's session owner even when no Bearer token is sent.
      if (!userId) {
        const sess = await Session.findOne({ refreshTokenHash: hash });
        if (sess) userId = sess.user;
      }
      await Session.updateMany({ refreshTokenHash: hash, revokedAt: null }, { $set: { revokedAt: new Date() } });
    }
    if (userId && !email) {
      const u = await User.findById(userId).select("email");
      email = u ? u.email : "";
    }
    clearRefreshCookie(res);
    await writeAuthAudit({ user: userId, email, event: "logout", success: true, req });
  } catch (_) { /* best effort */ }
  res.json({ message: "Logged out" });
};

// POST /api/auth/logout-all — bump tokenVersion (kills all access tokens) + revoke sessions.
exports.logoutAll = async (req, res, next) => {
  try {
    req.user.tokenVersion = (req.user.tokenVersion || 0) + 1;
    await req.user.save();
    await Session.updateMany({ user: req.user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    clearRefreshCookie(res);
    await writeAuthAudit({ user: req.user._id, email: req.user.email, event: "logout", success: true, req, metadata: { scope: "all" } });
    res.json({ message: "Signed out of all devices" });
  } catch (err) { next(err); }
};

// GET /api/me
exports.me = async (req, res) => res.json({ user: publicUser(req.user) });

// PUT /api/me — profile update; audits an address change.
exports.updateProfile = async (req, res, next) => {
  try {
    const { fullName, phone, address, email } = req.body;
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: "User not found" });

    const addressChanged = typeof address === "string" && address.trim() !== (user.address || "");

    if (typeof fullName === "string" && fullName.trim()) user.fullName = fullName.trim();
    if (typeof phone === "string") user.phone = phone.trim();
    if (typeof address === "string") user.address = address.trim();
    if (typeof email === "string" && email.trim()) {
      const newNorm = normalizeEmail(email);
      if (newNorm !== user.emailNormalized) {
        const taken = await User.findOne({ emailNormalized: newNorm });
        if (taken) return res.status(409).json({ message: "That email is already in use" });
        user.email = email.trim().toLowerCase();
        user.emailOriginal = email.trim();
        user.emailNormalized = newNorm;
        // (A later phase will require re-verification of a changed email.)
      }
    }
    await user.save();

    if (addressChanged) {
      await writeAuthAudit({ user: user._id, email: user.email, event: "address_update", success: true, req });
    }
    res.json({ user: publicUser(user) });
  } catch (err) { next(err); }
};

// GET /api/me/devices — active devices for this user (with coarse location + last seen).
exports.listDevices = async (req, res, next) => {
  try {
    const devices = await Device.find({ user: req.user._id, revokedAt: null }).sort({ lastSeenAt: -1 });
    const here = getOrIssueDeviceId(req, res);
    res.json(devices.map((d) => ({
      id: d._id, browser: d.browser, os: d.os, ipAddress: d.ipAddress,
      location: geoip.label({ city: d.approxCity, country: d.approxCountry }),
      firstSeenAt: d.firstSeenAt, lastSeenAt: d.lastSeenAt, lastLoginAt: d.lastLoginAt,
      current: d.deviceId === here,
    })));
  } catch (err) { next(err); }
};

// GET /api/me/sessions — active sign-in sessions (Phase 2.6; flag-gated).
exports.listSessions = async (req, res, next) => {
  try {
    if (!sessionUiOn()) return res.status(404).json({ message: "Session management is not enabled." });
    const raw = req.cookies && req.cookies[REFRESH_COOKIE];
    const currentHash = raw ? hashToken(raw) : null;
    const sessions = await Session.find({ user: req.user._id, revokedAt: null, expiresAt: { $gt: new Date() } })
      .populate("device").sort({ updatedAt: -1 });
    res.json(sessions.map((s) => {
      const d = s.device;
      return {
        id: s._id,
        browser: d ? d.browser : "", os: d ? d.os : "",
        ipAddress: s.ipAddress || (d ? d.ipAddress : ""),
        location: d ? geoip.label({ city: d.approxCity, country: d.approxCountry }) : "Unknown location",
        lastSeenAt: s.updatedAt, createdAt: s.createdAt, expiresAt: s.expiresAt,
        current: !!currentHash && s.refreshTokenHash === currentHash,
      };
    }));
  } catch (err) { next(err); }
};

// POST /api/me/sessions/revoke-all { password } — sign out EVERYWHERE (Phase 2.6).
// Requires password re-entry; revokes all sessions + bumps tokenVersion (kills this
// session too — the client must sign in again).
exports.revokeAllSessions = async (req, res, next) => {
  try {
    if (!sessionUiOn()) return res.status(404).json({ message: "Session management is not enabled." });
    const user = await User.findById(req.user._id).select("+password");
    if (!(await user.comparePassword(req.body.password || ""))) {
      await writeAuthAudit({ user: user._id, email: user.email, event: "all_sessions_revoked", success: false, req, metadata: { reason: "bad_password" } });
      return res.status(401).json({ code: "INVALID_PASSWORD", message: "Your password is incorrect." });
    }
    user.tokenVersion = (user.tokenVersion || 0) + 1; // revoke all access tokens
    await user.save();
    await Session.updateMany({ user: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    await Device.updateMany({ user: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    clearRefreshCookie(res);
    await writeAuthAudit({ user: user._id, email: user.email, event: "all_sessions_revoked", success: true, req });
    res.json({ message: "Signed out of all devices. Please sign in again." });
  } catch (err) { next(err); }
};

// DELETE /api/me/devices/:id — sign a device out (revoke its sessions).
exports.revokeDevice = async (req, res, next) => {
  try {
    const d = await Device.findOne({ _id: req.params.id, user: req.user._id });
    if (!d) return res.status(404).json({ message: "Device not found" });
    d.revokedAt = new Date(); await d.save();
    await Session.updateMany({ user: req.user._id, device: d._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    await writeAuthAudit({ user: req.user._id, email: req.user.email, event: "session_revoked", success: true, req, metadata: { deviceId: String(d._id) } });
    res.json({ message: "Device signed out" });
  } catch (err) { next(err); }
};
