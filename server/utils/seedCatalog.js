// Seed the REAL Farm To Kitchen catalog STRUCTURE (labels only).
// • Idempotent: real products are upserted by name with $setOnInsert, so re-running
//   never overwrites prices/stock/images an admin later enters.
// • Placeholder price:0 / stock:0 on every product + variant (to be filled in admin).
// • image:"" → the storefront/admin render the branded FTK placeholder (no internet images).
// • Demo products are ARCHIVED (status:"archived"), never deleted — orders/receipts/
//   payments/analytics/inventory history stay fully intact.
//
// Run from the server/ directory:  node utils/seedCatalog.js
require("dotenv").config();
const mongoose = require("mongoose");
const Product = require("../models/Product");

function v(label) { return { label: label, price: 0, stock: 0 }; }

// sku is assigned in the FTK-2xxx range to avoid colliding with demo SKUs (FTK-10xx).
const CATALOG = [
  { sku: "FTK-2001", name: "Ijebu Garri",                         category: "Garri",   variants: ["1kg", "3kg"] },
  { sku: "FTK-2002", name: "Bendel Garri",                        category: "Garri",   variants: ["1kg", "1.5kg", "3kg", "5kg"] },
  { sku: "FTK-2003", name: "White Yam Flour / Elubo",             category: "Flour",   variants: ["1kg", "1.5kg", "3kg", "5kg"] },
  { sku: "FTK-2004", name: "Black Yam Flour / Elubo",             category: "Flour",   variants: ["1kg", "1.5kg", "3kg"] },
  { sku: "FTK-2005", name: "Honey Beans / Ewa Oloyin",            category: "Legumes", variants: ["1kg", "3kg", "5kg"] },
  { sku: "FTK-2006", name: "Ogede Plantain Flour",               category: "Flour",   variants: ["1kg", "1.5kg", "4kg"] },
  { sku: "FTK-2007", name: "Ogbono / Wild Mango Seed",            category: "Spices",  variants: ["500 grams"] },
  { sku: "FTK-2008", name: "Ground Crayfish",                     category: "Seafood", variants: ["200 grams", "400 grams"] },
  { sku: "FTK-2009", name: "Ground Pepper / Spiced Ground Pepper", category: "Spices", variants: ["200 grams"] },
  { sku: "FTK-2010", name: "Palm Oil",                            category: "Oils",    variants: ["1.5L", "2.5L", "5L"] },
  { sku: "FTK-2011", name: "Groundnut",                           category: "Oils",    variants: ["75cl bottle", "1L bottle"] },
  // Spices — one bottle/jar unit each
  { sku: "FTK-2012", name: "Suya Spice",        category: "Spices", variants: ["1 bottle"] },
  { sku: "FTK-2013", name: "Fried Rice Spice",  category: "Spices", variants: ["1 bottle"] },
  { sku: "FTK-2014", name: "Jollof Spice",      category: "Spices", variants: ["1 bottle"] },
  { sku: "FTK-2015", name: "Curry Masala",      category: "Spices", variants: ["1 jar"] },
  { sku: "FTK-2016", name: "Turmeric",          category: "Spices", variants: ["1 jar"] },
  { sku: "FTK-2017", name: "Thyme",             category: "Spices", variants: ["1 jar"] },
  { sku: "FTK-2018", name: "Pepper Soup Spice", category: "Spices", variants: ["1 bottle"] },
];

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error("✖ MONGODB_URI not set"); process.exit(1); }
  await mongoose.connect(uri);

  const realNames = CATALOG.map((p) => p.name);

  // 1) Archive every product that is NOT part of the real catalog (the demos).
  //    Soft status change only — nothing is deleted.
  const archiveRes = await Product.updateMany(
    { name: { $nin: realNames } },
    { $set: { status: "archived" } }
  );

  // 2) Upsert each real product. $setOnInsert means a re-run will NOT clobber any
  //    prices/stock/images entered later in the admin.
  let inserted = 0, existing = 0;
  for (const p of CATALOG) {
    const res = await Product.updateOne(
      { name: p.name },
      {
        $setOnInsert: {
          name: p.name,
          sku: p.sku,
          category: p.category,
          price: 0,
          stock: 0,
          variants: p.variants.map(v),
          image: "",            // branded placeholder rendered until a real image is uploaded
          description: "",
          tag: "",
          status: "active",
        },
      },
      { upsert: true }
    );
    if (res.upsertedCount) inserted++; else existing++;
  }

  // Report
  const active = await Product.countDocuments({ status: { $ne: "archived" } });
  const archived = await Product.countDocuments({ status: "archived" });
  console.log("── Seed complete ──");
  console.log("Demo products archived (matched):", archiveRes.modifiedCount);
  console.log("Real products inserted:", inserted, "| already existed:", existing);
  console.log("Active products now:", active, "| Archived products now:", archived);

  await mongoose.disconnect();
}

run().catch((e) => { console.error("✖ Seed failed:", e.message); process.exit(1); });
