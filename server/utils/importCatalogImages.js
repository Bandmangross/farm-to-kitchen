// Bulk image import — reads files from /catalog-images, downscales them, and sets
// ONLY the `image` field on the matching product (by SKU). Touches nothing else:
// no prices, stock, variants, status, orders, payments, or other products.
//
// Resize: uses jimp if installed (downscale ≤900px, JPEG q82 — same target as the
// admin upload). If jimp is absent it stores the original bytes and warns.
//
// Run from the server/ directory:  node utils/importCatalogImages.js
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Product = require("../models/Product");

let Jimp = null, JimpMime = null;
try { const j = require("jimp"); Jimp = j.Jimp; JimpMime = j.JimpMime; } catch (_) { /* optional */ }

const IMAGES_DIR = path.join(require("os").homedir(), "Desktop", ":Users:bandman_gr:farm-to-kitchen:catalog-images:");
const MAX_DIM = 900;

// SKU → base filename (extension resolved at read time, case-insensitive).
// Filenames were CONTENT-VERIFIED by reading each package label — several files
// are misnamed (see the ⚠ notes), so these map to the ACTUAL product shown.
const MAP = [
  { sku: "FTK-2001", file: "ijebu_garri_variants" },                       // Ijebu Garri
  { sku: "FTK-2002", file: "garri_variants" },                             // Bendel Garri
  { sku: "FTK-2003", file: "groundnut_bottles_group" },                    // ⚠ actually White Yam Flour / Elubo
  { sku: "FTK-2004", file: "elubo_black_yam_flour_variants" },             // Black Yam Flour / Elubo
  { sku: "FTK-2005", file: "ogede_elubo_plantain_flour_variants" },        // ⚠ actually Honey Beans / Ewa Oloyin
  { sku: "FTK-2006", file: "ogede_elubo_plantain_flour_full_variants" },   // Ogede Plantain Flour (multi-bag, weights)
  { sku: "FTK-2007", file: "ogbono_wild_mango_seed" },                     // Ogbono / Wild Mango Seed
  { sku: "FTK-2008", file: "ground_pepper_spiced_ground_pepper" },         // ⚠ actually Ground Crayfish
  { sku: "FTK-2009", file: "ground_pepper_three_packs" },                  // Spiced Ground Pepper
  { sku: "FTK-2010", file: "palm_oil_variants" },                          // Palm Oil
  { sku: "FTK-2011", file: "honey_beans_variants" },                       // ⚠ actually Groundnut (group of bottles)
  // 7 spices share one image
  { sku: "FTK-2012", file: "spices_collection" },
  { sku: "FTK-2013", file: "spices_collection" },
  { sku: "FTK-2014", file: "spices_collection" },
  { sku: "FTK-2015", file: "spices_collection" },
  { sku: "FTK-2016", file: "spices_collection" },
  { sku: "FTK-2017", file: "spices_collection" },
  { sku: "FTK-2018", file: "spices_collection" },
];

const EXTS = [".jpg", ".jpeg", ".png", ".webp"];
function resolveFile(base) {
  if (!fs.existsSync(IMAGES_DIR)) return null;
  const entries = fs.readdirSync(IMAGES_DIR);
  const hit = entries.find((e) => {
    const ext = path.extname(e).toLowerCase();
    return path.basename(e, path.extname(e)).toLowerCase() === base.toLowerCase() && EXTS.includes(ext);
  });
  return hit ? path.join(IMAGES_DIR, hit) : null;
}

async function toDataUrl(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (Jimp) {
    const img = await Jimp.read(filePath);
    if (Math.max(img.bitmap.width, img.bitmap.height) > MAX_DIM) img.scaleToFit({ w: MAX_DIM, h: MAX_DIM });
    const isPng = ext === ".png";
    return await img.getBase64(isPng ? JimpMime.png : JimpMime.jpeg, isPng ? {} : { quality: 82 });
  }
  // Fallback: store original bytes (no resize).
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return "data:" + mime + ";base64," + fs.readFileSync(filePath).toString("base64");
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  if (!Jimp) console.warn("⚠ jimp not installed — storing ORIGINAL image bytes without downscaling.");
  if (!fs.existsSync(IMAGES_DIR)) { console.error("✖ Folder not found: " + IMAGES_DIR); process.exit(1); }

  const results = [];
  // de-dupe identical files so we only encode spices-group once
  const cache = {};
  for (const m of MAP) {
    const p = await Product.findOne({ sku: m.sku });
    if (!p) { results.push({ sku: m.sku, status: "NO PRODUCT" }); continue; }
    const fp = resolveFile(m.file);
    if (!fp) { results.push({ sku: m.sku, name: p.name, status: "FILE MISSING (" + m.file + ")" }); continue; }

    if (!cache[fp]) cache[fp] = await toDataUrl(fp);
    const dataUrl = cache[fp];
    const before = p.image ? (p.image.slice(0, 24) + "…") : "(placeholder/empty)";
    p.image = dataUrl;             // ONLY the image field
    await p.save();
    results.push({ sku: m.sku, name: p.name, file: path.basename(fp), before, afterKB: Math.round(dataUrl.length / 1024), status: "SET" });
  }

  console.table(results);
  const set = results.filter((r) => r.status === "SET").length;
  console.log(`\n${set}/${MAP.length} product images set. (resize: ${Jimp ? "jimp ≤900px" : "NONE — originals"})`);
  await mongoose.disconnect();
})().catch((e) => { console.error("✖ Import failed:", e.message); process.exit(1); });
