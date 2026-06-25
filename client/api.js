/**
 * Farm To Kitchen — frontend API client.
 *
 * Two SEPARATE JWT slots so the admin session can never hijack a customer session:
 *   • customer token → localStorage "ftk_token"        (register/login, account, checkout)
 *   • admin token    → localStorage "ftk_admin_token"  (admin dashboard only)
 *
 * Include on every page BEFORE your page script:  <script src="api.js"></script>
 */
(function () {
  // Frontend runs on http://localhost:3000, backend API on http://localhost:5050.
  var BASE = (window.FTK_API_BASE || "http://localhost:5050") + "/api";

  // ── Customer session ──
  function getToken() { return localStorage.getItem("ftk_token"); }
  function setToken(t) { t ? localStorage.setItem("ftk_token", t) : localStorage.removeItem("ftk_token"); }
  function getUser() { try { return JSON.parse(localStorage.getItem("ftk_user") || "null"); } catch (e) { return null; } }
  function setUser(u) { u ? localStorage.setItem("ftk_user", JSON.stringify(u)) : localStorage.removeItem("ftk_user"); }

  // ── Admin session (kept entirely separate) ──
  function getAdminToken() { return localStorage.getItem("ftk_admin_token"); }
  function setAdminToken(t) { t ? localStorage.setItem("ftk_admin_token", t) : localStorage.removeItem("ftk_admin_token"); }
  function getAdminUser() { try { return JSON.parse(localStorage.getItem("ftk_admin_user") || "null"); } catch (e) { return null; } }
  function setAdminUser(u) { u ? localStorage.setItem("ftk_admin_user", JSON.stringify(u)) : localStorage.removeItem("ftk_admin_user"); }

  // Exchange the HttpOnly refresh cookie for a fresh customer access token.
  async function refreshAccess() {
    try {
      var res = await fetch(BASE + "/auth/token/refresh", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
      });
      if (!res.ok) return false;
      var d = await res.json();
      if (d && d.token) { setToken(d.token); if (d.user) setUser(d.user); return true; }
    } catch (e) { /* offline / no cookie */ }
    return false;
  }

  // `auth` → customer token, `admin` → admin token. credentials:"include" so the
  // HttpOnly refresh + device cookies flow (same-origin in dev, allow-listed in prod).
  async function request(path, opts) {
    opts = opts || {};
    var method = opts.method || "GET", body = opts.body, auth = opts.auth, admin = opts.admin, _retry = opts._retry;
    var headers = { "Content-Type": "application/json" };
    if (admin && getAdminToken()) headers.Authorization = "Bearer " + getAdminToken();
    else if (auth && getToken()) headers.Authorization = "Bearer " + getToken();

    var res = await fetch(BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      credentials: "include",
    });

    var data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }

    if (!res.ok) {
      // Transparent one-shot refresh for an expired CUSTOMER access token.
      if (res.status === 401 && auth && !admin && !_retry) {
        var ok = await refreshAccess();
        if (ok) { opts._retry = true; return request(path, opts); }
      }
      var msg = (data && data.message) || ("Request failed (" + res.status + ")");
      var err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // POST with an explicit Bearer token (used for the short-lived admin enroll/challenge tokens).
  async function requestWithToken(path, token, body) {
    var res = await fetch(BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      credentials: "include",
      body: JSON.stringify(body || {}),
    });
    var data = null; try { data = await res.json(); } catch (e) {}
    if (!res.ok) { var err = new Error((data && data.message) || ("Request failed (" + res.status + ")")); err.status = res.status; err.data = data; throw err; }
    return data;
  }

  window.API = {
    // ── token/user helpers ──
    getToken: getToken,
    getUser: getUser,
    getAdminToken: getAdminToken,
    getAdminUser: getAdminUser,
    isLoggedIn: function () { return !!getToken(); },
    isAdmin: function () { var u = getAdminUser(); return !!u && u.role === "admin"; },

    // ── customer auth (uses the CUSTOMER token slot) ──
    register: async function (payload) {
      var d = await request("/register", { method: "POST", body: payload });
      setToken(d.token); setUser(d.user); return d;
    },
    login: async function (email, password) {
      var d = await request("/login", { method: "POST", body: { email: email, password: password } });
      setToken(d.token); setUser(d.user); return d;
    },
    logout: function () {
      // best-effort server-side session revoke (refresh cookie) — fire & forget
      try { fetch(BASE + "/logout", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" } }); } catch (e) {}
      setToken(null); setUser(null);
    },
    me: function () { return request("/me", { auth: true }); },
    updateProfile: async function (payload) {
      var d = await request("/me", { method: "PUT", body: payload, auth: true });
      if (d && d.user) setUser(d.user);
      return d;
    },

    // ── session & device management (Phase 2.6) ──
    sessions: {
      devices: function () { return request("/me/devices", { auth: true }); },
      list: function () { return request("/me/sessions", { auth: true }); },
      revokeDevice: function (id) { return request("/me/devices/" + id, { method: "DELETE", auth: true }); },
      revokeAll: async function (password) {
        var d = await request("/me/sessions/revoke-all", { method: "POST", body: { password: password }, auth: true });
        setToken(null); setUser(null); // tokenVersion bumped server-side → this session is dead
        return d;
      },
    },

    // ── email verification (Phase 2.2) ──
    email: {
      resend: function (email) { return request("/auth/email/resend", { method: "POST", body: { email: email }, auth: true }); },
      verify: function (payload) { return request("/auth/email/verify", { method: "POST", body: payload }); },
    },

    // ── phone verification (Phase 2.3) ──
    phone: {
      request: function (phone, channel) { return request("/auth/phone/request", { method: "POST", body: { phone: phone, channel: channel }, auth: true }); },
      verify: function (code) { return request("/auth/phone/verify", { method: "POST", body: { code: code }, auth: true }); },
      resend: function (channel) { return request("/auth/phone/resend", { method: "POST", body: { channel: channel }, auth: true }); },
    },

    // ── password reset & change (Phase 2.4) ──
    password: {
      forgot: function (email) { return request("/auth/password/forgot", { method: "POST", body: { email: email } }); },
      reset: function (payload) { return request("/auth/password/reset", { method: "POST", body: payload }); },
      change: async function (currentPassword, newPassword) {
        var d = await request("/auth/password/change", { method: "POST", body: { currentPassword: currentPassword, newPassword: newPassword }, auth: true });
        if (d && d.token) setToken(d.token); // current session stays signed in with the new token
        return d;
      },
    },

    // ── admin auth (Phase 2.5: dedicated /admin/login + MFA; no credential persistence) ──
    adminLogin: async function (email, password) {
      // → { token,user } (MFA off) | { mfaRequired,mfaToken } | { enrollmentRequired,enrollToken,user }
      var d = await request("/admin/login", { method: "POST", body: { email: email, password: password } });
      if (d && d.token) { setAdminToken(d.token); setAdminUser(d.user); }
      return d;
    },
    adminLoginMfa: async function (mfaToken, code) {
      var d = await request("/admin/login/mfa", { method: "POST", body: { mfaToken: mfaToken, code: code } });
      if (d && d.token) { setAdminToken(d.token); setAdminUser(d.user); }
      return d;
    },
    adminMfaSetup: function (enrollToken, password) { return requestWithToken("/admin/mfa/setup", enrollToken, { password: password }); },
    adminMfaEnable: function (enrollToken, password, code) { return requestWithToken("/admin/mfa/enable", enrollToken, { password: password, code: code }); },
    adminChangePassword: async function (currentPassword, newPassword) {
      var d = await request("/auth/password/change", { method: "POST", body: { currentPassword: currentPassword, newPassword: newPassword }, admin: true });
      if (d && d.token) { setAdminToken(d.token); } // change rotates the current session; keep the (MFA) admin token fresh
      return d;
    },
    adminMfaDisable: function (password, code) { return request("/admin/mfa/disable", { method: "POST", body: { password: password, code: code }, admin: true }); },
    adminRecoveryRegenerate: function (password, code) { return request("/admin/mfa/recovery/regenerate", { method: "POST", body: { password: password, code: code }, admin: true }); },
    adminLogout: function () { setAdminToken(null); setAdminUser(null); },
    users: { list: function () { return request("/users", { admin: true }); } },

    // ── admin orders dashboard (Phase 3; flag-gated server-side → 404 when off) ──
    adminOrders: {
      list: function (params) {
        var qs = params ? "?" + Object.keys(params).filter(function (k) { return params[k] != null && params[k] !== ""; }).map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); }).join("&") : "";
        return request("/admin/orders" + qs, { admin: true });
      },
      get: function (id) { return request("/admin/orders/" + encodeURIComponent(id), { admin: true }); },
      payments: function (id) { return request("/admin/orders/" + encodeURIComponent(id) + "/payments", { admin: true }); },
      inventory: function (id) { return request("/admin/orders/" + encodeURIComponent(id) + "/inventory", { admin: true }); },
      allPayments: function (params) { var qs = params ? "?page=" + (params.page || 1) : ""; return request("/admin/payments" + qs, { admin: true }); },
      allInventory: function (params) { var qs = params ? "?page=" + (params.page || 1) : ""; return request("/admin/inventory" + qs, { admin: true }); },
      cancel: function (id, reason) { return request("/admin/orders/" + encodeURIComponent(id) + "/cancel", { method: "POST", body: { reason: reason }, admin: true }); },
      refund: function (id, reason) { return request("/admin/orders/" + encodeURIComponent(id) + "/refund", { method: "POST", body: { reason: reason }, admin: true }); },
      release: function (id, reason) { return request("/admin/orders/" + encodeURIComponent(id) + "/release", { method: "POST", body: { reason: reason }, admin: true }); },
    },

    // ── products (list public; writes admin) ──
    products: {
      list: function (status) { return request("/products" + (status ? "?status=" + encodeURIComponent(status) : "")); },
      create: function (p) { return request("/products", { method: "POST", body: p, admin: true }); },
      update: function (id, p) { return request("/products/" + id, { method: "PUT", body: p, admin: true }); },
      remove: function (id) { return request("/products/" + id, { method: "DELETE", admin: true }); },
    },

    // ── orders ──
    orders: {
      my: function () { return request("/orders/my", { auth: true }); },      // customer → own orders
      list: function () { return request("/orders", { admin: true }); },       // admin → ALL orders
      create: function (o) { return request("/orders", { method: "POST", body: o, auth: true }); },
      updateStatus: function (id, status) { return request("/orders/" + id + "/status", { method: "PUT", body: { status: status }, admin: true }); },
    },

    // ── payments ──
    payments: {
      confirm: function (reference, orderId) { return request("/payments", { method: "POST", body: { reference: reference, orderId: orderId }, auth: true }); },
      list: function () { return request("/payments", { admin: true }); },
    },

    // ── analytics (admin) ──
    analytics: function () { return request("/analytics", { admin: true }); },
  };
})();
