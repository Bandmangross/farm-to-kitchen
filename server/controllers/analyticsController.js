const Order = require("../models/Order");
const Product = require("../models/Product");
const User = require("../models/User");
const ActivityLog = require("../models/ActivityLog");

// GET /api/analytics  (admin) — dashboard metrics + 7-day series + inventory summary
exports.dashboard = async (req, res, next) => {
  try {
    const [orders, products, customers, activity] = await Promise.all([
      Order.find(),
      Product.find(),
      User.countDocuments({ role: "customer" }),
      ActivityLog.find().sort({ createdAt: -1 }).limit(15),
    ]);

    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startWeek = new Date(startToday); startWeek.setDate(startWeek.getDate() - 6);
    const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    let revenue = 0, revToday = 0, revWeek = 0, revMonth = 0;
    let paid = 0, unpaid = 0, delivered = 0, cancelled = 0;
    const productCounts = {};

    orders.forEach((o) => {
      const g = o.grandTotal || 0;
      const isPaid = o.paymentStatus === "Paid" && o.status !== "Cancelled";
      if (isPaid) paid++; else unpaid++;
      if (o.status === "Delivered") delivered++;
      if (o.status === "Cancelled") cancelled++;
      if (isPaid) {
        revenue += g;
        const d = new Date(o.createdAt);
        if (d >= startToday) revToday += g;
        if (d >= startWeek) revWeek += g;
        if (d >= startMonth) revMonth += g;
      }
      (o.items || []).forEach((it) => { productCounts[it.name] = (productCounts[it.name] || 0) + 1; });
    });

    let topProduct = "—", topCount = 0;
    Object.keys(productCounts).forEach((n) => { if (productCounts[n] > topCount) { topCount = productCounts[n]; topProduct = n; } });

    // Inventory summary
    const LOW = 10;
    let inStock = 0, lowStock = 0, outStock = 0, inventoryValue = 0;
    products.forEach((p) => {
      if (p.stock <= 0) outStock++; else if (p.stock <= LOW) lowStock++; else inStock++;
      inventoryValue += (p.price || 0) * (p.stock || 0);
    });

    res.json({
      totals: {
        customers,
        orders: orders.length,
        revenue, revToday, revWeek, revMonth,
        paidOrders: paid, unpaidOrders: unpaid,
        deliveredOrders: delivered, cancelledOrders: cancelled,
        avgOrderValue: paid ? Math.round(revenue / paid) : 0,
        topProduct,
      },
      inventory: { totalProducts: products.length, inStock, lowStock, outStock, inventoryValue },
      activity,
    });
  } catch (err) {
    next(err);
  }
};
