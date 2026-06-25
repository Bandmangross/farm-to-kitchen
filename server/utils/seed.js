/**
 * Seed / migration script.
 *   node utils/seed.js            → seed default products + admin user
 *   node utils/seed.js import.json → also import an exported localStorage dump
 *
 * To migrate existing browser data: in the old app's browser console run
 *   copy(JSON.stringify({
 *     products: JSON.parse(localStorage.getItem("ftk_products") || "[]"),
 *     orders:   JSON.parse(localStorage.getItem("orderHistory") || "[]")
 *   }))
 * paste into a file (e.g. import.json) and pass it as the argument.
 */
require("dotenv").config();
const fs = require("fs");
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Product = require("../models/Product");
const Order = require("../models/Order");
const User = require("../models/User");

const DEFAULT_PRODUCTS = [
  { name: "Rice", sku: "FTK-1001", category: "Grains", price: 5000, stock: 120, image: "https://images.unsplash.com/photo-1586201375761-83865001e31c?w=400", description: "Premium quality long-grain rice.", tag: "Bestseller" },
  { name: "Beans", sku: "FTK-1002", category: "Legumes", price: 4000, stock: 90, image: "https://images.unsplash.com/photo-1515543237350-b3eea1ec8082?w=400", description: "Fresh and nutritious brown beans." },
  { name: "Ofada Rice", sku: "FTK-1003", category: "Grains", price: 6000, stock: 60, image: "https://images.unsplash.com/photo-1536304993881-ff6e9eefa2a6?w=400", description: "Authentic Nigerian Ofada Rice.", tag: "Local" },
  { name: "Plantain Flour", sku: "FTK-1004", category: "Flour", price: 3500, stock: 75, image: "https://images.unsplash.com/photo-1574323347407-f5e1ad6d020b?w=400", description: "Healthy plantain flour for every meal." },
];

async function run() {
  await connectDB();

  // 1. Admin user
  const adminEmail = (process.env.SEED_ADMIN_EMAIL || "admin@farmtokitchen.com").toLowerCase();
  if (!(await User.findOne({ email: adminEmail }))) {
    await User.create({
      fullName: "Store Admin",
      email: adminEmail,
      phone: "0000000000",
      password: process.env.SEED_ADMIN_PASSWORD || "admin1234", // hashed by the model hook
      role: "admin",
    });
    console.log("✔ Admin user created:", adminEmail);
  } else {
    console.log("• Admin user already exists:", adminEmail);
  }

  // 2. Default products — restore/ensure each of the four staples exists (idempotent).
  //    Upsert by SKU so re-running never duplicates and always restores missing ones.
  for (const p of DEFAULT_PRODUCTS) {
    const result = await Product.updateOne(
      { sku: p.sku },
      { $setOnInsert: p },
      { upsert: true }
    );
    if (result.upsertedCount) console.log(`✔ Restored default product: ${p.name} (${p.sku})`);
  }
  console.log(`• Ensured ${DEFAULT_PRODUCTS.length} default products (Rice, Beans, Ofada Rice, Plantain Flour)`);

  // 3. Optional import of an exported localStorage dump
  const file = process.argv[2];
  if (file && fs.existsSync(file)) {
    const dump = JSON.parse(fs.readFileSync(file, "utf8"));

    for (const p of dump.products || []) {
      await Product.updateOne(
        { sku: p.sku || p.name },
        { $setOnInsert: { name: p.name, sku: p.sku, category: p.category || "General", price: p.price || 0, stock: p.stock || 0, image: p.image || "", description: p.description || "", tag: p.tag || "" } },
        { upsert: true }
      );
    }

    for (const o of dump.orders || []) {
      if (!o.orderId) continue; // skip legacy orders without an id
      const items = (o.items || []).map((it) => {
        const parts = String(it).split(" - ");
        return { name: parts[0], quantity: parts[1] || "1", units: parseInt(parts[1], 10) || 1, price: 0 };
      });
      await Order.updateOne(
        { orderId: o.orderId },
        { $setOnInsert: {
            orderId: o.orderId, customerName: o.customerName, customerEmail: (o.customerEmail || "").toLowerCase(),
            customerPhone: o.customerPhone, customerAddress: o.customerAddress, items,
            quantity: items.length, total: o.total || 0, deliveryFee: o.deliveryFee || 0,
            grandTotal: o.grandTotal || 0, amount: o.grandTotal || 0,
            paymentMethod: o.paymentMethod || "Paystack", paymentStatus: o.paymentStatus || "Awaiting Payment",
            status: o.status || "Awaiting Payment", transactionRef: o.transactionRef || null, date: o.date,
        } },
        { upsert: true }
      );
    }
    console.log("✔ Imported localStorage dump:", file);
  }

  await mongoose.disconnect();
  console.log("✔ Seed complete");
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
