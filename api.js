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

  // `auth` → customer token, `admin` → admin token.
  async function request(path, { method = "GET", body, auth = false, admin = false } = {}) {
    var headers = { "Content-Type": "application/json" };
    if (admin && getAdminToken()) headers.Authorization = "Bearer " + getAdminToken();
    else if (auth && getToken()) headers.Authorization = "Bearer " + getToken();

    var res = await fetch(BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    var data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }

    if (!res.ok) {
      var msg = (data && data.message) || ("Request failed (" + res.status + ")");
      var err = new Error(msg);
      err.status = res.status;
      throw err;
    }
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
    logout: function () { setToken(null); setUser(null); },
    me: function () { return request("/me", { auth: true }); },
    updateProfile: async function (payload) {
      var d = await request("/me", { method: "PUT", body: payload, auth: true });
      if (d && d.user) setUser(d.user);
      return d;
    },

    // ── admin auth (uses the separate ADMIN token slot) ──
    adminLogin: async function (email, password) {
      var d = await request("/login", { method: "POST", body: { email: email, password: password } });
      setAdminToken(d.token); setAdminUser(d.user); return d;
    },
    adminLogout: function () { setAdminToken(null); setAdminUser(null); },
    users: { list: function () { return request("/users", { admin: true }); } },

    // ── products (list public; writes admin) ──
    products: {
      list: function () { return request("/products"); },
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
