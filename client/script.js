let cartItems =
JSON.parse(localStorage.getItem("cartItems")) || [];

let cartPrices =
JSON.parse(localStorage.getItem("cartPrices")) || [];

let cartTotal =
parseInt(localStorage.getItem("cartTotal")) || 0;

let cartCount = cartItems.length;
let deliveryFee = 3000;

// Branded, network-free fallback image (inline SVG data URI). Shown whenever a
// product has no image OR its image fails to load — so we NEVER show a broken icon.
var FTK_PLACEHOLDER = "data:image/svg+xml;utf8," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">' +
    '<rect width="400" height="300" fill="#eef7f0"/>' +
    '<circle cx="200" cy="118" r="46" fill="#d8ecdd"/>' +
    '<text x="200" y="130" font-family="Arial,Helvetica,sans-serif" font-size="30" font-weight="bold" fill="#0b7a34" text-anchor="middle">FTK</text>' +
    '<text x="200" y="200" font-family="Arial,Helvetica,sans-serif" font-size="22" font-weight="bold" fill="#0b7a34" text-anchor="middle">Farm To Kitchen</text>' +
    '<text x="200" y="226" font-family="Arial,Helvetica,sans-serif" font-size="13" fill="#7a8a7f" text-anchor="middle">Image coming soon</text>' +
    '</svg>'
);
if (typeof window !== "undefined") {
    window.FTK_PLACEHOLDER = FTK_PLACEHOLDER;
    // Reusable <img onerror> handler — swaps a failed image for the branded placeholder.
    window.ftkImgFallback = function (img) { img.onerror = null; img.src = FTK_PLACEHOLDER; };
}
const ricePrices = {
    "1kg": 5000,
    "2kg": 10000,
    "5kg": 25000,
    "10kg": 50000,
    "25kg": 125000,
    "50kg": 250000
};const beansPrices = {
    "1kg": 4000,
    "2kg": 8000,
    "5kg": 20000,
    "10kg": 40000,
    "25kg": 100000,
    "50kg": 200000
};

const ofadaPrices = {
    "1kg": 6000,
    "2kg": 12000,
    "5kg": 30000,
    "10kg": 60000,
    "25kg": 150000,
    "50kg": 300000
};

const plantainFlourPrices = {
    "1kg": 3500,
    "2kg": 7000,
    "5kg": 17500,
    "10kg": 35000,
    "25kg": 87500,
    "50kg": 175000
};
function welcomeMessage() {
    alert("Welcome to Farm To Kitchen 🌾");

}

// Default catalogue — kept in sync with the admin panel's ftk_products store.
const DEFAULT_PRODUCTS = [
    { id: "p-rice",     name: "Rice",           price: 5000, stock: 120, image: "https://images.unsplash.com/photo-1586201375761-83865001e31c?w=600", description: "Premium quality long-grain rice.", tag: "Bestseller" },
    { id: "p-beans",    name: "Beans",          price: 4000, stock: 90,  image: "https://images.unsplash.com/photo-1515543237350-b3eea1ec8082?w=600", description: "Fresh and nutritious brown beans." },
    { id: "p-ofada",    name: "Ofada Rice",     price: 6000, stock: 60,  image: "https://images.unsplash.com/photo-1536304993881-ff6e9eefa2a6?w=600", description: "Authentic Nigerian Ofada Rice.", tag: "Local" },
    { id: "p-plantain", name: "Plantain Flour", price: 3500, stock: 75,  image: "https://images.unsplash.com/photo-1574323347407-f5e1ad6d020b?w=600", description: "Healthy plantain flour for every meal." }
];

// Products come from MongoDB (via the API). A synchronous cache backs the render
// code; until the API resolves we fall back to the local cache, then defaults.
let productCache = null;

function normalizeStoreProduct(p) {
    var variants = Array.isArray(p.variants)
        ? p.variants.map(function (v) {
            return { label: String(v.label || "").trim(), price: Number(v.price) || 0, stock: Number(v.stock) || 0 };
        }).filter(function (v) { return v.label; })
        : [];
    return {
        id: p._id || p.id,
        name: p.name,
        sku: p.sku || "",
        category: p.category || "General",
        price: Number(p.price) || 0,
        stock: Number(p.stock) || 0,
        variants: variants,
        image: p.image || "",
        description: p.description || "",
        tag: p.tag || "",
        status: p.status || "active"
    };
}

// Total available stock for a product: sum of variant stock when variants exist,
// otherwise the flat product stock (legacy). Drives the storefront stock badge.
function productTotalStock(p) {
    if (p && Array.isArray(p.variants) && p.variants.length) {
        return p.variants.reduce(function (s, v) { return s + (Number(v.stock) || 0); }, 0);
    }
    return Number(p && p.stock) || 0;
}

function getProducts() {
    if (productCache) return productCache;
    try {
        const saved = JSON.parse(localStorage.getItem("ftk_products") || "null");
        if (Array.isArray(saved) && saved.length) return saved.map(normalizeStoreProduct);
    } catch (e) { console.error(e); }
    return DEFAULT_PRODUCTS.slice();
}

// Load products. MongoDB (API) is the source of truth; localStorage/defaults are
// used ONLY if the API request fails. Sets productCache and returns the source.
async function loadProductsFromAPI() {
    if (window.API) {
        try {
            const list = await API.products.list();
            productCache = list.map(normalizeStoreProduct);
            // API succeeded → make it authoritative and drop any stale local cache.
            try { localStorage.setItem("ftk_products", JSON.stringify(productCache)); } catch (e) {}
            console.log("%c[FTK] Products loaded from API (MongoDB): " + productCache.length,
                "color:#1f7a3f;font-weight:bold", productCache.map(function (p) { return p.name; }));
            return "api";
        } catch (e) {
            console.warn("[FTK] Products API request FAILED — falling back to localStorage/defaults.", e);
        }
    } else {
        console.warn("[FTK] API client (api.js) not loaded — using fallback products.");
    }

    // Fallback path (API unavailable)
    try {
        const saved = JSON.parse(localStorage.getItem("ftk_products") || "null");
        if (Array.isArray(saved) && saved.length) {
            productCache = saved.map(normalizeStoreProduct);
            console.warn("[FTK] Products loaded from localStorage FALLBACK:", productCache.map(function (p) { return p.name; }));
            return "localStorage";
        }
    } catch (e) {}
    productCache = DEFAULT_PRODUCTS.map(normalizeStoreProduct);
    console.warn("[FTK] Products loaded from built-in DEFAULTS (no API, no cache).");
    return "defaults";
}

// Dynamic footer "Shop" links — built from the SAME product list, not hardcoded.
function renderFooterProductLinks() {
    const box = document.getElementById("footer-product-links");
    if (!box) return;
    const products = getProducts();
    box.innerHTML = products.map(function (p) {
        return '<a href="#products" data-footer-product="' + escAttr(p.id) + '">' + escHtml(p.name) + '</a>';
    }).join("");
    box.querySelectorAll("[data-footer-product]").forEach(function (link) {
        link.addEventListener("click", function (e) {
            e.preventDefault();
            jumpToProduct(this.dataset.footerProduct); // scroll to + highlight that product
        });
    });
}

// Initialise the storefront: load products FIRST (API), then paint grid + footer.
async function initStorefront() {
    await loadProductsFromAPI();
    renderStorefrontProducts();
    renderFooterProductLinks();
    // Re-render the cart so thumbnails use freshly-loaded product images.
    if (typeof displayCart === "function") displayCart();
}

// Stock status for storefront badges — matches the admin Inventory Center thresholds.
const LOW_STOCK = 10;
function stockStatus(stock) {
    stock = Number(stock) || 0;
    if (stock <= 0)         return { key: "out", label: "Out Of Stock", cls: "stk-out" };
    if (stock <= LOW_STOCK) return { key: "low", label: "Low Stock",   cls: "stk-low" };
    return { key: "in", label: "In Stock", cls: "stk-in" };
}

// Price for a chosen unit.
//   • Variant product → the selected variant's OWN price (exact, no kg math).
//   • Legacy product  → base price × kg figure (original tier pricing, unchanged).
function resolvePrice(productName, quantity) {
    const product = getProducts().filter(function (p) { return p.name === productName; })[0];
    if (product && Array.isArray(product.variants) && product.variants.length) {
        const want = String(quantity).trim().toLowerCase();
        const v = product.variants.filter(function (x) { return String(x.label).trim().toLowerCase() === want; })[0];
        if (v) return Number(v.price) || 0;
    }
    const kg = parseInt(quantity, 10) || 1;
    if (product) return Number(product.price) * kg;
    // Legacy fallback for the original four products
    const legacy = { "Rice": ricePrices, "Beans": beansPrices, "Ofada Rice": ofadaPrices, "Plantain Flour": plantainFlourPrices };
    return (legacy[productName] && legacy[productName][quantity]) || 0;
}

function addToCart(productName, quantityId) {
    var quantity = document.getElementById(quantityId).value;
    var price = resolvePrice(productName, quantity);

    // Underlying model is UNCHANGED: one entry per unit, "Name - weight - ₦price".
    // (checkout.html / payment.html parse these exact strings — do not alter format.)
    cartItems.push(productName + " - " + quantity + " - ₦" + price.toLocaleString());
    cartPrices.push(price);

    recomputeCart();
    persistCart();
    displayCart();
    updateSummaryUI();

    var msg = document.getElementById("cart-message");
    if (msg) msg.innerHTML = productName + " added to cart ✅";
}
// ── Cart helpers (single source of truth for totals + persistence) ──
function recomputeCart() {
    cartTotal = cartPrices.reduce(function (s, p) { return s + (Number(p) || 0); }, 0);
    cartCount = cartItems.length;
}
function persistCart() {
    localStorage.setItem("cartItems", JSON.stringify(cartItems));
    localStorage.setItem("cartPrices", JSON.stringify(cartPrices));
    localStorage.setItem("cartTotal", cartTotal);
}
// Delivery fee only applies when there are items (cleaner empty-state summary).
function updateSummaryUI() {
    var hasItems = cartItems.length > 0;
    var df = hasItems ? deliveryFee : 0;
    var ct = document.getElementById("cart-total");
    var dfEl = document.getElementById("delivery-fee");
    var gt = document.getElementById("grand-total");
    var cc = document.getElementById("cart-count");
    if (ct) ct.innerHTML = "₦" + cartTotal.toLocaleString();
    if (dfEl) dfEl.innerHTML = "₦" + df.toLocaleString();
    if (gt) gt.innerHTML = "₦" + (cartTotal + df).toLocaleString();
    if (cc) cc.innerHTML = "Cart: " + cartCount + " items";
}
function checkout() {
    let name = document.getElementById("customer-name").value;
    let email = document.getElementById("customer-email").value;
    let address = document.getElementById("customer-address").value;
    let phone = document.getElementById("customer-phone").value;

    if (name === "" || email === "" || address === "" || phone === "") {
        alert("Please fill in all checkout details.");
        return;
    }

    if (cartItems.length === 0) {
        alert("Your cart is empty.");
        return;
    }

    let order = {
        customerName: name,
        customerEmail: email,
        customerAddress: address,
        customerPhone: phone,
        items: [...cartItems],
        total: cartTotal,
        deliveryFee: deliveryFee,
        grandTotal: cartTotal + deliveryFee,
        date: new Date().toLocaleString()
    };

    let orderHistory =
        JSON.parse(localStorage.getItem("orderHistory")) || [];

    orderHistory.push(order);

    console.log("Saving order history:", orderHistory);

    localStorage.setItem("orderHistory", JSON.stringify(orderHistory));

    alert(localStorage.getItem("orderHistory"));

    document.getElementById("summary-details").innerHTML =
        "<h3>Customer Information</h3>" +
        "Name: " + name + "<br>" +
        "Email: " + email + "<br>" +
        "Address: " + address + "<br>" +
        "Phone: " + phone + "<br><br>" +
        "<h3>Order Items</h3>" +
        cartItems.join("<br>") +
        "<br><br><strong>Total: ₦" +
        cartTotal.toLocaleString() +
        "</strong><br>" +
        "<strong>Delivery Fee: ₦" +
        deliveryFee.toLocaleString() +
        "</strong><br>" +
        "<strong>Grand Total: ₦" +
        (cartTotal + deliveryFee).toLocaleString() +
        "</strong>";

    alert("Order placed successfully! 🎉");

    cartItems = [];
    cartPrices = [];
    cartCount = 0;
    cartTotal = 0;

    localStorage.removeItem("cartItems");
    localStorage.removeItem("cartPrices");
    localStorage.removeItem("cartTotal");

    document.getElementById("cart-items").innerHTML =
        "No items added yet.";

    document.getElementById("cart-count").innerHTML =
        "Cart: 0 items";

    document.getElementById("cart-total").innerHTML =
        "Total: ₦0";

    document.getElementById("grand-total").innerHTML =
        "Grand Total: ₦" + deliveryFee.toLocaleString();
}
function clearCart() {
    if (cartItems.length && !confirm("Clear all items from your cart?")) return;

    cartItems = [];
    cartPrices = [];
    cartCount = 0;
    cartTotal = 0;
    localStorage.removeItem("cartItems");
    localStorage.removeItem("cartPrices");
    localStorage.removeItem("cartTotal");

    displayCart();
    updateSummaryUI();
}function removeLastItem() {

    if (cartItems.length === 0) {
        return;
    }

    let removedPrice = cartPrices.pop();

    cartItems.pop();

    cartCount = cartCount - 1;

    cartTotal = cartTotal - removedPrice;

    displayCart();

    document.getElementById("cart-count").innerHTML =
        "Cart: " + cartCount + " items";

        document.getElementById("grand-total").innerHTML =
    "Grand Total: ₦" +
    (cartTotal + deliveryFee).toLocaleString();

    document.getElementById("cart-total").innerHTML =
        "Total: ₦" + cartTotal.toLocaleString();
}
// ── Grouped cart view ──
// The storage model stays a flat list of "Name - weight - ₦price" strings.
// For display we group identical lines into one card with a quantity, so the
// +/- buttons simply add/remove underlying entries (totals + checkout untouched).
var cartGroups = [];
function buildCartGroups() {
    cartGroups = [];
    var index = {};
    for (var i = 0; i < cartItems.length; i++) {
        var line = cartItems[i];
        var gi = index[line];
        if (gi == null) {
            var parts = String(line).split(" - ");
            gi = cartGroups.length;
            index[line] = gi;
            cartGroups.push({
                line: line,
                name: (parts[0] || line).trim(),
                weight: (parts[1] || "").trim(),
                unitPrice: Number(cartPrices[i]) || 0,
                qty: 0
            });
        }
        cartGroups[gi].qty += 1;
    }
    return cartGroups;
}
function cartProductImage(name) {
    var p = getProducts().filter(function (x) { return x.name === name; })[0];
    return (p && p.image) || "";
}
// Reusable Feather "trash-2" icon for the per-variant remove button.
var TRASH_SVG =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<polyline points="3 6 5 6 21 6"></polyline>' +
        '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>' +
        '<path d="M10 11v6"></path><path d="M14 11v6"></path>' +
        '<path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path>' +
    '</svg>';

// Cart header subline: "3 Products • 12 Total Items".
function setCartSubline(productCount, totalUnits) {
    var el = document.getElementById("cart-subline");
    if (!el) return;
    if (!totalUnits) { el.textContent = ""; return; }
    el.textContent =
        productCount + (productCount === 1 ? " Product" : " Products") +
        " • " +
        totalUnits + (totalUnits === 1 ? " Total Item" : " Total Items");
}
// Second-level grouping: roll the flat variant-groups up by PRODUCT NAME so the
// cart shows one card per product (Amazon/Shopify style) with its weight variants
// nested inside. Each variant keeps its ORIGINAL index into cartGroups, so the
// existing +/-/remove handlers (which act per variant) stay untouched.
function buildProductGroups() {
    var products = [];
    var index = {};
    for (var i = 0; i < cartGroups.length; i++) {
        var g = cartGroups[i];
        var pi = index[g.name];
        if (pi == null) {
            pi = products.length;
            index[g.name] = pi;
            products.push({ name: g.name, image: cartProductImage(g.name), variants: [], subtotal: 0, units: 0 });
        }
        var lineTotal = g.unitPrice * g.qty;
        products[pi].variants.push({ idx: i, weight: g.weight, unitPrice: g.unitPrice, qty: g.qty, lineTotal: lineTotal });
        products[pi].subtotal += lineTotal;
        products[pi].units += g.qty;
    }
    return products;
}

function displayCart() {
    var box = document.getElementById("cart-items");
    if (!box) return;
    buildCartGroups();

    if (cartGroups.length === 0) {
        setCartSubline(0, 0);
        box.innerHTML =
            '<div class="cart-empty">' +
                '<div class="cart-empty-ico">🛒</div>' +
                '<h3>Your cart is empty</h3>' +
                '<p>Browse our products and add items to begin shopping.</p>' +
                '<a class="btn-continue" href="#products">Continue Shopping</a>' +
            '</div>';
        return;
    }

    var products = buildProductGroups();
    var totalUnits = 0;
    var html = "";

    for (var p = 0; p < products.length; p++) {
        var prod = products[p];
        totalUnits += prod.units;

        var rowsHtml = "";
        for (var v = 0; v < prod.variants.length; v++) {
            var vt = prod.variants[v];
            rowsHtml +=
                '<tr class="cv-row">' +
                    '<td class="cv-weight-cell"><span class="cv-weight">' + escHtml(vt.weight || "—") + '</span></td>' +
                    '<td class="cv-qty-cell">' +
                        '<div class="cart-qty">' +
                            '<button class="qbtn" onclick="cartDec(' + vt.idx + ')" aria-label="Decrease quantity">−</button>' +
                            '<span class="qval">' + vt.qty + '</span>' +
                            '<button class="qbtn" onclick="cartInc(' + vt.idx + ')" aria-label="Increase quantity">+</button>' +
                        '</div>' +
                    '</td>' +
                    '<td class="cv-unit-cell" data-label="Unit Price">₦' + vt.unitPrice.toLocaleString() + '</td>' +
                    '<td class="cv-total-cell" data-label="Total">₦' + vt.lineTotal.toLocaleString() + '</td>' +
                    '<td class="cv-remove-cell">' +
                        '<button class="cart-trash" title="Remove Variant" aria-label="Remove Variant" onclick="cartRemoveGroup(' + vt.idx + ')">' + TRASH_SVG + '</button>' +
                    '</td>' +
                '</tr>';
        }

        html +=
            '<div class="cart-product">' +
                '<div class="cp-head">' +
                    '<div class="cart-thumb">' +
                        '<img src="' + (prod.image ? escAttr(prod.image) : FTK_PLACEHOLDER) + '" alt="' + escAttr(prod.name) + '" onerror="ftkImgFallback(this)">' +
                    '</div>' +
                    '<p class="cp-name">' + escHtml(prod.name) + '</p>' +
                '</div>' +
                '<table class="cp-table">' +
                    '<tbody>' + rowsHtml + '</tbody>' +
                '</table>' +
                '<div class="cp-foot">' +
                    '<span class="cp-foot-label">Subtotal</span>' +
                    '<span class="cp-foot-val">₦' + prod.subtotal.toLocaleString() + '</span>' +
                '</div>' +
            '</div>';
    }

    // Single column-header strip at the very top (not repeated per product).
    var colHead =
        '<table class="cp-table cart-colhead"><thead><tr>' +
            '<th class="cv-weight-cell">Weight</th>' +
            '<th class="cv-qty-cell">Quantity</th>' +
            '<th class="cv-unit-cell">Unit Price</th>' +
            '<th class="cv-total-cell">Total</th>' +
            '<th class="cv-remove-cell">Remove</th>' +
        '</tr></thead></table>';

    // Header subline: "X Products • Y Total Items"
    setCartSubline(products.length, totalUnits);

    box.innerHTML = colHead + html;
}
// + → add one more identical unit.
function cartInc(groupIndex) {
    var g = cartGroups[groupIndex];
    if (!g) return;
    cartItems.push(g.line);
    cartPrices.push(g.unitPrice);
    recomputeCart(); persistCart(); displayCart(); updateSummaryUI();
}
// − → remove a single matching unit (card disappears when it hits zero).
function cartDec(groupIndex) {
    var g = cartGroups[groupIndex];
    if (!g) return;
    var idx = cartItems.indexOf(g.line);
    if (idx === -1) return;
    cartItems.splice(idx, 1);
    cartPrices.splice(idx, 1);
    recomputeCart(); persistCart(); displayCart(); updateSummaryUI();
}
// 🗑 → remove the whole line, with confirmation.
function cartRemoveGroup(groupIndex) {
    var g = cartGroups[groupIndex];
    if (!g) return;
    var label = g.name + (g.weight ? " (" + g.weight + ")" : "");
    if (!confirm("Remove " + label + " from your cart?")) return;
    for (var i = cartItems.length - 1; i >= 0; i--) {
        if (cartItems[i] === g.line) {
            cartItems.splice(i, 1);
            cartPrices.splice(i, 1);
        }
    }
    recomputeCart(); persistCart(); displayCart(); updateSummaryUI();
}
function deleteItem(index) {

    let removedPrice = cartPrices[index];

    cartItems.splice(index, 1);
    cartPrices.splice(index, 1);

    cartCount = cartItems.length;

    cartTotal = cartTotal - removedPrice;

    localStorage.setItem("cartItems", JSON.stringify(cartItems));
    localStorage.setItem("cartPrices", JSON.stringify(cartPrices));
    localStorage.setItem("cartTotal", cartTotal);

    displayCart();

    document.getElementById("cart-count").innerHTML =
        "Cart: " + cartCount + " items";

    document.getElementById("cart-total").innerHTML =
        "Total: ₦" + cartTotal.toLocaleString();

    document.getElementById("grand-total").innerHTML =
        "Grand Total: ₦" +
        (cartTotal + deliveryFee).toLocaleString();
}
function showCheckout() {

    document.getElementById("checkout").scrollIntoView({
        behavior: "smooth"
    });
}function toggleAccountMenu() {
    let dropdown = document.getElementById("account-dropdown");

    if (dropdown.style.display === "block") {
        dropdown.style.display = "none";
    } else {
        dropdown.style.display = "block";
    }
}

function closeAccountMenu() {
    document.getElementById("account-dropdown").style.display = "none";
}function logout() {
    // Clear the real auth session (server revoke + all client keys), not just the legacy flag.
    if (window.API && API.logout) API.logout();
    localStorage.removeItem("loggedInUser");
    localStorage.removeItem("fullName");
    alert("Logged out successfully!");
    window.location.reload();
}

let accountDropdown = document.getElementById("account-dropdown");
let accountIcon = document.getElementById("account-icon");
let savedName = localStorage.getItem("fullName");
let loggedInUser = localStorage.getItem("loggedInUser");

function escHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
}

if (accountDropdown && accountIcon) {
    accountIcon.innerHTML = "👤";

    // Prefer the real auth session (ftk_user) and fall back to legacy localStorage.
    var apiUser = (window.API && API.getUser) ? API.getUser() : null;
    var isLoggedIn = (window.API && API.isLoggedIn && API.isLoggedIn()) || !!loggedInUser;
    var custName = (apiUser && apiUser.name) || savedName || "Customer";
    var custEmail = (apiUser && apiUser.email) || loggedInUser || "";

    if (isLoggedIn) {
        accountDropdown.innerHTML =
            '<div class="dd-profile">' +
                '<span class="dd-avatar">👤</span>' +
                '<div class="dd-id">' +
                    '<span class="dd-name">' + escHtml(custName) + '</span>' +
                    (custEmail ? '<span class="dd-email">' + escHtml(custEmail) + '</span>' : '') +
                '</div>' +
            '</div>' +
            '<div class="dd-divider"></div>' +
            '<a href="account.html#overview" onclick="closeAccountMenu()">Account Center</a>' +
            '<a href="#" onclick="closeAccountMenu(); if(window.FTKAssistant){FTKAssistant.open(\'support\');} return false;">Support Center</a>' +
            '<a href="#" class="dd-logout" onclick="logout()">Logout</a>';
    } else {
        accountDropdown.innerHTML =
            '<a href="account.html" onclick="closeAccountMenu()">Create Account</a>' +
            '<a href="account.html" onclick="closeAccountMenu()">Login</a>' +
            '<a href="#products" onclick="closeAccountMenu()">Shop</a>';
    }

    accountDropdown.style.display = "none";
}
// Initial paint on load (also rehydrates the cart from localStorage).
recomputeCart();
displayCart();
updateSummaryUI();

// ── Render storefront products from the live catalogue (admin-managed) ──
function escAttr(v) {
    return String(v == null ? "" : v)
        .replace(/&/g, "&amp;").replace(/"/g, "&quot;")
        .replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escHtml(v) { var d = document.createElement("div"); d.textContent = v == null ? "" : v; return d.innerHTML; }

function renderStorefrontProducts() {
    var grid = document.getElementById("product-grid");
    if (!grid) return; // only present on the storefront

    var products = getProducts().filter(function (p) { return p.status !== "archived" && p.status !== "draft"; }); // storefront hides archived + draft
    var qtyOpts = ["1kg", "2kg", "5kg", "10kg", "25kg", "50kg"]; // legacy fallback (no-variant products)

    // Branded empty state when the active catalogue is empty.
    if (!products.length) {
        grid.innerHTML =
            '<div class="store-empty">' +
                '<div class="store-empty-ico">🌾</div>' +
                '<h3>Our shelves are being restocked</h3>' +
                '<p>New Farm To Kitchen products are coming soon. Please check back shortly.</p>' +
            '</div>';
        return;
    }

    grid.innerHTML = products.map(function (p, i) {
        var qid = "qty-" + (p.id || i);
        var tag = p.tag
            ? '<span class="product-tag' + (p.tag === "Local" ? " tag-green" : "") + '">' + escHtml(p.tag) + '</span>'
            : '';
        var hasV = Array.isArray(p.variants) && p.variants.length;
        // Requirement 3/8: stock status derived from TOTAL available (variant sum or flat stock).
        var total = productTotalStock(p);
        var out = total <= 0;
        var st = stockStatus(total);
        var stockBadge = '<span class="stock-badge ' + st.cls + '">' + st.label + '</span>';

        // Each product renders its OWN units. Out-of-stock variants are disabled individually.
        var opts = hasV
            ? p.variants.map(function (v) {
                var vout = (Number(v.stock) || 0) <= 0;
                return '<option value="' + escAttr(v.label) + '"' + (vout ? ' disabled' : '') + '>' +
                    escHtml(v.label) + ' — ₦' + (Number(v.price) || 0).toLocaleString() + (vout ? ' (Out of stock)' : '') +
                    '</option>';
            }).join("")
            : qtyOpts.map(function (q) { return "<option>" + q + "</option>"; }).join("");

        return '<article class="product-card" id="product-' + escAttr(p.id || i) + '">' +
            '<div class="product-image" role="button" tabindex="0" data-pid="' + escAttr(p.id || i) + '" aria-label="View details for ' + escAttr(p.name) + '"><img src="' + (p.image ? escAttr(p.image) : FTK_PLACEHOLDER) + '" alt="' + escAttr(p.name) + '" onerror="ftkImgFallback(this)">' + tag + stockBadge + '</div>' +
            '<div class="product-body">' +
                '<h3 role="button" tabindex="0" data-pid="' + escAttr(p.id || i) + '" aria-label="View details for ' + escAttr(p.name) + '">' + escHtml(p.name) + '</h3>' +
                '<p class="product-desc">' + escHtml(p.description || "") + '</p>' +
                '<p class="product-price">From <strong>₦' + (Number(p.price) || 0).toLocaleString() + '</strong></p>' +
                '<label for="' + qid + '">Quantity</label>' +
                '<select id="' + qid + '"' + (out ? ' disabled' : '') + '>' + opts + '</select>' +
                (out
                    ? '<button class="btn-add" disabled style="opacity:.5;cursor:not-allowed">Out of Stock</button>'
                    : '<button class="btn-add" data-name="' + escAttr(p.name) + '" data-qty="' + qid + '">Add To Cart</button>') +
            '</div></article>';
    }).join("");

    grid.querySelectorAll(".btn-add[data-name]").forEach(function (btn) {
        btn.addEventListener("click", function () {
            addToCart(this.dataset.name, this.dataset.qty);
        });
    });

    // Image OR title opens the Product Details modal (mouse + keyboard).
    grid.querySelectorAll("[data-pid]").forEach(function (el) {
        function open() { openProductDetails(el.getAttribute("data-pid")); }
        el.addEventListener("click", open);
        el.addEventListener("keydown", function (e) {
            if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") { e.preventDefault(); open(); }
        });
    });
}

// ── Product Details modal (quick view; display-only, no data/API/cart changes) ──
var _pdLastFocus = null;
function ensureProductModal() {
    var m = document.getElementById("pd-modal");
    if (m) return m;
    m = document.createElement("div");
    m.id = "pd-modal";
    m.className = "pd-modal";
    m.setAttribute("role", "dialog");
    m.setAttribute("aria-modal", "true");
    m.setAttribute("aria-label", "Product details");
    m.setAttribute("aria-hidden", "true");
    document.body.appendChild(m);
    m.addEventListener("click", function (e) { if (e.target === m) closeProductDetails(); }); // click outside
    return m;
}
function openProductDetails(pid) {
    var p = getProducts().filter(function (x) { return String(x.id) === String(pid); })[0];
    if (!p) return;
    var total = productTotalStock(p);
    var st = stockStatus(total);
    var img = p.image ? escAttr(p.image) : FTK_PLACEHOLDER;
    var hasV = Array.isArray(p.variants) && p.variants.length;
    var variantsHtml = hasV
        ? p.variants.map(function (v) {
            var vout = (Number(v.stock) || 0) <= 0;
            return '<div class="pd-variant' + (vout ? ' is-out' : '') + '">' +
                '<span class="pdv-label">' + escHtml(v.label) + '</span>' +
                '<span class="pdv-price">₦' + (Number(v.price) || 0).toLocaleString() + '</span>' +
                '<span class="pdv-stock ' + (vout ? 'pdv-out' : 'pdv-in') + '">' + (vout ? 'Out of stock' : 'In stock') + '</span>' +
            '</div>';
        }).join("")
        : '<p class="pd-desc">—</p>';

    var m = ensureProductModal();
    m.innerHTML =
        '<div class="pd-dialog">' +
            '<button class="pd-close" type="button" aria-label="Close product details">&times;</button>' +
            '<div class="pd-media" id="pd-media" title="Click to zoom"><img src="' + img + '" alt="' + escAttr(p.name) + '" onerror="ftkImgFallback(this)"></div>' +
            '<div class="pd-info">' +
                '<h2>' + escHtml(p.name) + '</h2>' +
                '<span class="pd-status stock-badge ' + st.cls + '">' + st.label + '</span>' +
                '<p class="pd-price">From <strong>₦' + (Number(p.price) || 0).toLocaleString() + '</strong></p>' +
                (p.description ? '<p class="pd-desc">' + escHtml(p.description) + '</p>' : '') +
                '<p class="pd-variants-title">Available ' + (hasV ? 'Units' : 'Options') + '</p>' +
                variantsHtml +
            '</div>' +
        '</div>';

    m.querySelector(".pd-close").addEventListener("click", closeProductDetails);
    var media = m.querySelector("#pd-media");
    if (media) media.addEventListener("click", function () { var im = media.querySelector("img"); if (im) openImageModal(im.src, im.alt); });

    _pdLastFocus = document.activeElement;
    m.classList.add("open");
    m.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    m.querySelector(".pd-close").focus();
}
function closeProductDetails() {
    var m = document.getElementById("pd-modal");
    if (!m) return;
    m.classList.remove("open");
    m.setAttribute("aria-hidden", "true");
    var img = document.getElementById("img-modal");
    if (!(img && img.classList.contains("open"))) document.body.style.overflow = "";
    if (_pdLastFocus && _pdLastFocus.focus) _pdLastFocus.focus();
}

// ── Product image lightbox (display-only; no product/data changes) ──
var _imgModalLastFocus = null;
function ensureImageModal() {
    var modal = document.getElementById("img-modal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "img-modal";
    modal.className = "img-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Product image preview");
    modal.setAttribute("aria-hidden", "true");
    modal.innerHTML =
        '<button class="img-modal__close" type="button" aria-label="Close image preview">&times;</button>' +
        '<img class="img-modal__img" alt="">';
    document.body.appendChild(modal);
    modal.querySelector(".img-modal__close").addEventListener("click", closeImageModal);
    modal.addEventListener("click", function (e) { if (e.target === modal) closeImageModal(); }); // click outside the image
    return modal;
}
function openImageModal(src, alt) {
    if (!src) return;
    var modal = ensureImageModal();
    var img = modal.querySelector(".img-modal__img");
    img.src = src; img.alt = alt || "Product image";
    _imgModalLastFocus = document.activeElement;
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden"; // lock scroll while open
    modal.querySelector(".img-modal__close").focus();
}
function closeImageModal() {
    var modal = document.getElementById("img-modal");
    if (!modal) return;
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    // keep scroll locked if the product-details modal is still open underneath
    var pd = document.getElementById("pd-modal");
    if (!(pd && pd.classList.contains("open"))) document.body.style.overflow = "";
    if (_imgModalLastFocus && _imgModalLastFocus.focus) _imgModalLastFocus.focus();
}
// ESC closes the topmost open modal (lightbox first, then product details).
document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    var img = document.getElementById("img-modal");
    if (img && img.classList.contains("open")) { closeImageModal(); return; }
    var pd = document.getElementById("pd-modal");
    if (pd && pd.classList.contains("open")) closeProductDetails();
});

initStorefront();   // load from MongoDB first, then render grid + footer links

// ── Product search — live suggestions + jump-to-product ──
function jumpToProduct(id) {
    var card = document.getElementById("product-" + id);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.remove("product-highlight");
    // restart the highlight animation
    void card.offsetWidth;
    card.classList.add("product-highlight");
    var results = document.getElementById("product-search-results");
    if (results) results.hidden = true;
}

function searchProducts() {
    var input = document.getElementById("product-search");
    if (!input) return false;
    var q = input.value.toLowerCase().trim();
    if (!q) return false;
    var products = getProducts();
    var match = products.filter(function (p) {
        return (p.name + " " + (p.category || "") + " " + (p.description || "")).toLowerCase().indexOf(q) !== -1;
    })[0];
    if (match) {
        jumpToProduct(match.id);
    } else {
        var grid = document.getElementById("product-grid");
        if (grid) grid.scrollIntoView({ behavior: "smooth", block: "start" });
        alert('No product found for "' + input.value.trim() + '".');
    }
    return false; // prevent form submit/reload
}

function setupProductSearch() {
    var input = document.getElementById("product-search");
    var results = document.getElementById("product-search-results");
    if (!input || !results) return;

    input.addEventListener("input", function () {
        var q = this.value.toLowerCase().trim();
        if (!q) { results.hidden = true; results.innerHTML = ""; return; }
        var matches = getProducts().filter(function (p) {
            return (p.name + " " + (p.category || "") + " " + (p.description || "")).toLowerCase().indexOf(q) !== -1;
        }).slice(0, 6);

        if (!matches.length) {
            results.innerHTML = '<div class="ps-empty">No products found.</div>';
        } else {
            results.innerHTML = matches.map(function (p) {
                var st = stockStatus(p.stock);
                return '<div class="ps-item" data-id="' + escAttr(p.id) + '">' +
                    '<img src="' + (p.image ? escAttr(p.image) : FTK_PLACEHOLDER) + '" alt="" onerror="ftkImgFallback(this)">' +
                    '<span class="ps-name">' + escHtml(p.name) + '</span>' +
                    '<span class="ps-badge ' + st.cls + '">' + st.label + '</span></div>';
            }).join("");
        }
        results.hidden = false;

        results.querySelectorAll(".ps-item").forEach(function (item) {
            item.addEventListener("click", function () {
                input.value = "";
                jumpToProduct(this.dataset.id);
            });
        });
    });

    // Hide suggestions when clicking elsewhere
    document.addEventListener("click", function (e) {
        if (!e.target.closest(".product-search-wrap")) results.hidden = true;
    });
}

setupProductSearch();
