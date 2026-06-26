/**
 * Farm To Kitchen — floating Assistant Help Bot.
 *
 * Self-contained UI widget: injects its own styles + DOM, so it works on every
 * customer page regardless of cached CSS. Read-only — it consumes existing APIs
 * (orders/products) but never mutates checkout, payments, inventory or auth.
 *
 * Include AFTER api.js (optional):  <script src="assistant.js"></script>
 */
(function () {
  "use strict";

  // ── Support contact (single source of truth for the bot) ──
  var SUPPORT_EMAIL = "support@farmtokitchen.ng";
  var SUPPORT_PHONE = "+234 800 326 7625";
  var SUPPORT_HOURS = "Mon–Sat, 8:00am – 7:00pm WAT";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function naira(n) {
    var v = Number(n || 0);
    return "₦" + v.toLocaleString();
  }

  // ─────────────────────────────────────────────────────────
  //  STYLES
  // ─────────────────────────────────────────────────────────
  var css = '' +
    '.ftk-fab{position:fixed;right:20px;bottom:20px;z-index:99998;display:flex;align-items:center;gap:9px;' +
      'height:54px;padding:0 20px 0 16px;border:none;border-radius:30px;background:#1f7a3f;color:#fff;' +
      'font-size:15px;font-weight:700;cursor:pointer;box-shadow:0 10px 26px rgba(31,122,63,.34);' +
      'transition:transform .18s ease,box-shadow .18s ease,background .18s ease;font-family:inherit;}' +
    '.ftk-fab:hover{transform:translateY(-3px);background:#1a6b37;box-shadow:0 14px 32px rgba(31,122,63,.42);}' +
    '.ftk-fab .ftk-fab-ico{font-size:21px;line-height:1;}' +
    '@media(max-width:540px){.ftk-fab{padding:0;width:56px;height:56px;justify-content:center;border-radius:50%;}' +
      '.ftk-fab .ftk-fab-label{display:none;}}' +

    '.ftk-panel{position:fixed;right:20px;bottom:20px;z-index:99999;width:370px;max-width:calc(100vw - 32px);' +
      'height:560px;max-height:calc(100vh - 40px);background:#fff;border-radius:18px;overflow:hidden;' +
      'box-shadow:0 24px 60px rgba(0,0,0,.26);display:none;flex-direction:column;' +
      'transform:translateY(18px) scale(.98);opacity:0;transition:transform .2s ease,opacity .2s ease;' +
      'font-family:inherit;}' +
    '.ftk-panel.open{display:flex;transform:none;opacity:1;}' +

    '.ftk-head{background:linear-gradient(135deg,#1f7a3f,#27914b);color:#fff;padding:16px 18px;display:flex;' +
      'align-items:center;gap:11px;}' +
    '.ftk-head .ftk-h-ava{width:38px;height:38px;border-radius:50%;background:rgba(255,255,255,.18);' +
      'display:flex;align-items:center;justify-content:center;font-size:19px;}' +
    '.ftk-head .ftk-h-tt{font-size:15.5px;font-weight:800;line-height:1.2;}' +
    '.ftk-head .ftk-h-sub{font-size:12px;opacity:.9;display:flex;align-items:center;gap:5px;}' +
    '.ftk-head .ftk-dot{width:7px;height:7px;border-radius:50%;background:#7CFFA8;display:inline-block;}' +
    '.ftk-head .ftk-close{margin-left:auto;background:rgba(255,255,255,.16);border:none;color:#fff;' +
      'width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:16px;line-height:1;}' +
    '.ftk-head .ftk-close:hover{background:rgba(255,255,255,.3);}' +

    '.ftk-body{flex:1;overflow-y:auto;padding:16px;background:#f6f8f6;}' +
    '.ftk-row{display:flex;margin-bottom:12px;}' +
    '.ftk-row.user{justify-content:flex-end;}' +
    '.ftk-bub{max-width:84%;padding:11px 14px;border-radius:14px;font-size:13.7px;line-height:1.5;' +
      'box-shadow:0 1px 2px rgba(0,0,0,.05);white-space:pre-wrap;word-wrap:break-word;}' +
    '.ftk-row.bot .ftk-bub{background:#fff;color:#2b2f33;border-bottom-left-radius:5px;}' +
    '.ftk-row.user .ftk-bub{background:#1f7a3f;color:#fff;border-bottom-right-radius:5px;}' +
    '.ftk-bub strong{font-weight:700;}' +
    '.ftk-bub a{color:#1f7a3f;font-weight:600;}' +
    '.ftk-row.user .ftk-bub a{color:#eafff0;}' +
    '.ftk-status{display:inline-block;margin-top:3px;padding:2px 9px;border-radius:20px;font-size:11.5px;' +
      'font-weight:700;}' +

    '.ftk-qa{padding:12px 14px 16px;border-top:1px solid #eef0ee;background:#fff;}' +
    '.ftk-qa-tt{font-size:11px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:#a7adb4;' +
      'margin:0 2px 9px;}' +
    '.ftk-qa-grid{display:flex;flex-wrap:wrap;gap:8px;}' +
    '.ftk-chip{flex:1 1 auto;display:inline-flex;align-items:center;gap:6px;padding:9px 13px;border:1px solid #d9e6dd;' +
      'background:#f4faf5;color:#1f7a3f;border-radius:22px;font-size:12.8px;font-weight:600;cursor:pointer;' +
      'transition:background .15s,border-color .15s,transform .12s;font-family:inherit;white-space:nowrap;}' +
    '.ftk-chip:hover{background:#e8f5ec;border-color:#1f7a3f;transform:translateY(-1px);}' +

    '.ftk-typing{display:inline-flex;gap:4px;padding:13px 15px;}' +
    '.ftk-typing span{width:7px;height:7px;border-radius:50%;background:#bcc3c9;animation:ftkb 1s infinite;}' +
    '.ftk-typing span:nth-child(2){animation-delay:.15s;}.ftk-typing span:nth-child(3){animation-delay:.3s;}' +
    '@keyframes ftkb{0%,60%,100%{opacity:.3;transform:translateY(0);}30%{opacity:1;transform:translateY(-3px);}}';

  // ─────────────────────────────────────────────────────────
  //  MOUNT
  // ─────────────────────────────────────────────────────────
  function mount() {
    if (document.getElementById("ftk-assistant-fab")) return;

    var style = document.createElement("style");
    style.id = "ftk-assistant-style";
    style.textContent = css;
    document.head.appendChild(style);

    var fab = document.createElement("button");
    fab.id = "ftk-assistant-fab";
    fab.className = "ftk-fab";
    fab.setAttribute("aria-label", "Open Assistant");
    fab.innerHTML = '<span class="ftk-fab-ico">💬</span><span class="ftk-fab-label">Assistant</span>';

    var panel = document.createElement("div");
    panel.id = "ftk-assistant-panel";
    panel.className = "ftk-panel";
    panel.innerHTML = '' +
      '<div class="ftk-head">' +
        '<span class="ftk-h-ava">🌾</span>' +
        '<div>' +
          '<div class="ftk-h-tt">Farm To Kitchen Assistant</div>' +
          '<div class="ftk-h-sub"><span class="ftk-dot"></span> Online now</div>' +
        '</div>' +
        '<button class="ftk-close" id="ftk-assistant-close" aria-label="Close">✕</button>' +
      '</div>' +
      '<div class="ftk-body" id="ftk-assistant-body"></div>' +
      '<div class="ftk-qa">' +
        '<p class="ftk-qa-tt">Quick actions</p>' +
        '<div class="ftk-qa-grid">' +
          '<button class="ftk-chip" data-act="track">📦 Track My Order</button>' +
          '<button class="ftk-chip" data-act="delivery">🚚 Delivery Questions</button>' +
          '<button class="ftk-chip" data-act="product">🥬 Product Questions</button>' +
          '<button class="ftk-chip" data-act="payment">💳 Payment Questions</button>' +
          '<button class="ftk-chip" data-act="support">📞 Contact Support</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(fab);
    document.body.appendChild(panel);

    fab.addEventListener("click", function () { toggle(); });
    panel.querySelector("#ftk-assistant-close").addEventListener("click", function () { close(); });
    panel.querySelectorAll(".ftk-chip").forEach(function (b) {
      b.addEventListener("click", function () { handle(b.getAttribute("data-act")); });
    });
  }

  // ─────────────────────────────────────────────────────────
  //  PANEL OPEN/CLOSE
  // ─────────────────────────────────────────────────────────
  var greeted = false;
  function open(act) {
    var panel = document.getElementById("ftk-assistant-panel");
    var fab = document.getElementById("ftk-assistant-fab");
    if (!panel) return;
    panel.classList.add("open");
    if (fab) fab.style.display = "none";
    if (!greeted) {
      botSay("Hi 👋\nHow can I help you today? Pick a quick action below to get started.");
      greeted = true;
    }
    if (act) setTimeout(function () { handle(act); }, 250);
  }
  function close() {
    var panel = document.getElementById("ftk-assistant-panel");
    var fab = document.getElementById("ftk-assistant-fab");
    if (panel) panel.classList.remove("open");
    if (fab) fab.style.display = "";
  }
  function toggle() {
    var panel = document.getElementById("ftk-assistant-panel");
    if (panel && panel.classList.contains("open")) close(); else open();
  }

  // ─────────────────────────────────────────────────────────
  //  MESSAGES
  // ─────────────────────────────────────────────────────────
  function body() { return document.getElementById("ftk-assistant-body"); }
  function scroll() { var b = body(); if (b) b.scrollTop = b.scrollHeight; }

  function userSay(text) {
    var b = body(); if (!b) return;
    var row = document.createElement("div");
    row.className = "ftk-row user";
    row.innerHTML = '<div class="ftk-bub">' + esc(text) + '</div>';
    b.appendChild(row); scroll();
  }
  function botSay(html) {
    var b = body(); if (!b) return;
    var row = document.createElement("div");
    row.className = "ftk-row bot";
    row.innerHTML = '<div class="ftk-bub">' + html + '</div>';
    b.appendChild(row); scroll();
  }
  function typing() {
    var b = body(); if (!b) return null;
    var row = document.createElement("div");
    row.className = "ftk-row bot";
    row.innerHTML = '<div class="ftk-bub ftk-typing"><span></span><span></span><span></span></div>';
    b.appendChild(row); scroll();
    return row;
  }
  // Show a typing indicator, then replace it with the resolved bot message.
  function botReply(producer) {
    var t = typing();
    setTimeout(function () {
      Promise.resolve()
        .then(producer)
        .then(function (html) {
          if (t) t.remove();
          botSay(html || "Sorry, I couldn't find that right now.");
        })
        .catch(function () {
          if (t) t.remove();
          botSay("Something went wrong on my end. Please try again, or reach our team at <a href=\"mailto:" + SUPPORT_EMAIL + "\">" + SUPPORT_EMAIL + "</a>.");
        });
    }, 480);
  }

  // ─────────────────────────────────────────────────────────
  //  STATUS COLOURS (display-only; mirrors order statuses)
  // ─────────────────────────────────────────────────────────
  function statusChip(status) {
    var s = String(status || "Pending");
    var map = {
      Pending:    ["#fff4e0", "#b9770e"],
      Processing: ["#e6f0ff", "#1c5fd6"],
      Paid:       ["#e8f5ec", "#1f7a3f"],
      Shipped:    ["#eef0ff", "#4b4bd6"],
      Delivered:  ["#e8f5ec", "#1f7a3f"],
      Cancelled:  ["#fdecea", "#c0392b"]
    };
    var c = map[s] || ["#eef0ee", "#555"];
    return '<span class="ftk-status" style="background:' + c[0] + ';color:' + c[1] + '">' + esc(s) + '</span>';
  }

  // ─────────────────────────────────────────────────────────
  //  QUICK-ACTION HANDLERS  (read-only)
  // ─────────────────────────────────────────────────────────
  function loggedIn() { return !!(window.API && API.isLoggedIn && API.isLoggedIn()); }

  function handle(act) {
    if (act === "track") {
      userSay("📦 Track My Order");
      botReply(trackOrder);
    } else if (act === "delivery") {
      userSay("🚚 Delivery Questions");
      botReply(deliveryInfo);
    } else if (act === "product") {
      userSay("🥬 Product Questions");
      botReply(productInfo);
    } else if (act === "payment") {
      userSay("💳 Payment Questions");
      botReply(paymentInfo);
    } else if (act === "support") {
      userSay("📞 Contact Support");
      botReply(supportInfo);
    }
  }

  // Track My Order → latest order status for the signed-in customer.
  function trackOrder() {
    if (!loggedIn() || !(window.API && API.orders && API.orders.my)) {
      return 'To track an order, please <a href="account.html">sign in to your account</a> first. ' +
             'Once signed in, I can show your latest order status here. You can also view all orders in your ' +
             '<a href="account.html#my-orders">Account Center → My Orders</a>.';
    }
    return API.orders.my().then(function (orders) {
      orders = Array.isArray(orders) ? orders : (orders && orders.orders) || [];
      if (!orders.length) {
        return "You don't have any orders yet. When you place one, its status will show up here. " +
               'Ready to shop? <a href="index.html#products">Browse products →</a>';
      }
      // Newest first (API already sorts, but be defensive).
      orders.sort(function (a, b) {
        return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
      });
      var o = orders[0];
      var ref = o.orderId || o.reference || o._id || "—";
      var when = o.createdAt ? new Date(o.createdAt).toLocaleDateString() : "";
      var total = (o.total != null) ? o.total : (o.grandTotal != null ? o.grandTotal : null);
      var items = Array.isArray(o.items) ? o.items.length : null;
      var out = "Here's your <strong>latest order</strong>:<br>" +
        "<strong>Order:</strong> " + esc(ref) + (when ? " &middot; " + esc(when) : "") + "<br>" +
        (items != null ? "<strong>Items:</strong> " + items + "<br>" : "") +
        (total != null ? "<strong>Total:</strong> " + esc(naira(total)) + "<br>" : "") +
        "<strong>Status:</strong> " + statusChip(o.status) + "<br><br>" +
        'See full details in your <a href="account.html#my-orders">Account Center → My Orders</a>.';
      return out;
    });
  }

  function deliveryInfo() {
    return "<strong>🚚 Delivery information</strong><br><br>" +
      "&bull; <strong>Lagos &amp; major cities:</strong> 1–3 business days<br>" +
      "&bull; <strong>Other states:</strong> 3–5 business days<br>" +
      "&bull; <strong>Delivery fee:</strong> a flat ₦3,000 within Nigeria<br>" +
      "&bull; Orders are processed once payment is confirmed.<br><br>" +
      "You'll see your order move from <em>Processing</em> → <em>Shipped</em> → <em>Delivered</em> in " +
      '<a href="account.html#my-orders">My Orders</a>.';
  }

  function productInfo() {
    if (!(window.API && API.products && API.products.list)) {
      return "We sell farm-fresh staples including Rice, Beans, Ofada Rice and Plantain Flour. " +
             'Browse the full catalogue on our <a href="index.html#products">shop page →</a>';
    }
    return API.products.list().then(function (products) {
      products = Array.isArray(products) ? products : (products && products.products) || [];
      if (!products.length) {
        return 'Our catalogue is updating right now — please check the <a href="index.html#products">shop page →</a>';
      }
      var rows = products.slice(0, 8).map(function (p) {
        var price = (p.price != null) ? " — " + naira(p.price) : "";
        var stock = (p.stock != null)
          ? (Number(p.stock) > 0 ? ' <span class="ftk-status" style="background:#e8f5ec;color:#1f7a3f">In stock</span>'
                                  : ' <span class="ftk-status" style="background:#fdecea;color:#c0392b">Out of stock</span>')
          : "";
        return "&bull; <strong>" + esc(p.name) + "</strong>" + esc(price) + stock;
      }).join("<br>");
      return "<strong>🥬 Our products</strong><br><br>" + rows + "<br><br>" +
        'Tap any item on the <a href="index.html#products">shop page</a> to add it to your cart.';
    });
  }

  function paymentInfo() {
    var base = "<strong>💳 Payments</strong><br><br>" +
      "&bull; We accept secure card payments via <strong>Paystack</strong> (cards, transfer, USSD).<br>" +
      "&bull; Your order is confirmed as <strong>Paid</strong> the moment payment succeeds.<br>" +
      "&bull; Payments are processed securely — we never store your card details.<br><br>";
    if (!loggedIn() || !(window.API && API.orders && API.orders.my)) {
      return base + "Want to check a specific order's payment status? " +
        '<a href="account.html">Sign in</a> and I can look it up for you.';
    }
    return API.orders.my().then(function (orders) {
      orders = Array.isArray(orders) ? orders : (orders && orders.orders) || [];
      if (!orders.length) {
        return base + "You don't have any orders yet, so there's nothing to pay for right now.";
      }
      orders.sort(function (a, b) { return new Date(b.createdAt || 0) - new Date(a.createdAt || 0); });
      var o = orders[0];
      var ref = o.orderId || o.reference || o._id || "—";
      return base + "Your latest order <strong>" + esc(ref) + "</strong> is currently: " +
        statusChip(o.status) + "<br><br>" +
        'Manage it anytime in <a href="account.html#my-orders">My Orders</a>.';
    });
  }

  function supportInfo() {
    return "<strong>📞 Contact Support</strong><br><br>" +
      "We're happy to help! Reach our team:<br><br>" +
      '&bull; <strong>Email:</strong> <a href="mailto:' + SUPPORT_EMAIL + '">' + SUPPORT_EMAIL + "</a><br>" +
      '&bull; <strong>Phone:</strong> <a href="tel:' + SUPPORT_PHONE.replace(/\s+/g, "") + '">' + SUPPORT_PHONE + "</a><br>" +
      "&bull; <strong>Hours:</strong> " + SUPPORT_HOURS;
  }

  // ─────────────────────────────────────────────────────────
  //  PUBLIC API + BOOT
  // ─────────────────────────────────────────────────────────
  window.FTKAssistant = {
    open: function (act) { open(act); },
    close: close,
    toggle: toggle
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
