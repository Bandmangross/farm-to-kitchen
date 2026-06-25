const Product = require("../models/Product");
const Inventory = require("../models/Inventory");
const logActivity = require("../utils/activity");

// Clean a client-supplied variants array → [{label, price, stock}] (drops blanks).
// Returns null when `variants` was not provided at all (so update can tell "leave as-is").
function sanitizeVariants(raw) {
  if (!Array.isArray(raw)) return null;
  return raw
    .map((v) => ({ label: String((v && v.label) || "").trim(), price: Number(v && v.price) || 0, stock: Number(v && v.stock) || 0 }))
    .filter((v) => v.label);
}

// Requirement 3: for variant products, product.price = lowest variant price ("From ₦")
// and product.stock = sum of variant stock. Keeps legacy readers working unchanged.
function deriveFromVariants(variants, fallbackPrice, fallbackStock) {
  if (variants && variants.length) {
    return {
      price: Math.min.apply(null, variants.map((v) => v.price)),
      stock: variants.reduce((s, v) => s + v.stock, 0),
    };
  }
  return { price: Number(fallbackPrice) || 0, stock: Number(fallbackStock) || 0 };
}

// Generate the next SKU like FTK-1001 based on the current max.
async function nextSku() {
  const products = await Product.find({}, "sku");
  let max = 1000;
  products.forEach((p) => {
    const m = /FTK-(\d+)/.exec(p.sku || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return "FTK-" + (max + 1);
}

// GET /api/products  (public — storefront + admin)
//   • default            → visible only (storefront): not archived AND not draft
//   • ?status=all        → every product (admin management)
//   • ?status=archived   → archived only
//   • ?status=draft      → drafts only
// $nin also matches legacy docs with no status field (treated as visible/active).
exports.list = async (req, res, next) => {
  try {
    const s = req.query.status;
    const filter =
      s === "all" ? {}
      : s === "archived" ? { status: "archived" }
      : s === "draft" ? { status: "draft" }
      : { status: { $nin: ["archived", "draft"] } };
    const products = await Product.find(filter).sort({ createdAt: 1 });
    res.json(products);
  } catch (err) {
    next(err);
  }
};

// POST /api/products  (admin)
exports.create = async (req, res, next) => {
  try {
    const { name, price, stock, category, description, image, tag } = req.body;
    if (!name) return res.status(400).json({ message: "Product name is required" });

    const variants = sanitizeVariants(req.body.variants) || [];
    const derived = deriveFromVariants(variants, price, stock);

    const product = await Product.create({
      name,
      sku: req.body.sku || (await nextSku()),
      category: category || "General",
      price: derived.price,
      stock: derived.stock,
      variants,
      description: description || "",
      image: image || "",
      tag: tag || "",
    });

    await Inventory.create({
      product: product._id, productName: product.name,
      type: "set", quantity: product.stock, balanceAfter: product.stock,
      reason: "product created", user: req.user._id,
    });
    await logActivity({ type: "product", icon: "🆕", message: `Product added: ${product.name}`, user: req.user._id });

    res.status(201).json(product);
  } catch (err) {
    next(err);
  }
};

// PUT /api/products/:id  (admin) — edit fields and/or adjust stock
exports.update = async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: "Product not found" });

    const before = product.stock;
    const fields = ["name", "price", "stock", "category", "description", "image", "tag", "status"];
    fields.forEach((f) => {
      if (req.body[f] !== undefined) product[f] = f === "price" || f === "stock" ? Number(req.body[f]) : req.body[f];
    });

    // Variants (req 1/3): when provided, replace the set and DERIVE price/stock from it.
    const variants = sanitizeVariants(req.body.variants);
    if (variants !== null) {
      product.variants = variants;
      product.markModified("variants");
      const derived = deriveFromVariants(
        variants,
        req.body.price !== undefined ? req.body.price : product.price,
        req.body.stock !== undefined ? req.body.stock : product.stock
      );
      product.price = derived.price;
      product.stock = derived.stock;
    }
    await product.save();

    if (product.stock !== before) {
      const diff = product.stock - before;
      await Inventory.create({
        product: product._id, productName: product.name,
        type: diff > 0 ? "in" : "out", quantity: Math.abs(diff), balanceAfter: product.stock,
        reason: "admin adjustment", user: req.user._id,
      });
      await logActivity({
        type: "stock", icon: diff > 0 ? "📈" : "📉",
        message: `Stock ${diff > 0 ? "increased" : "reduced"}: ${product.name} (${before} → ${product.stock})`,
        user: req.user._id,
      });
    } else {
      await logActivity({ type: "product", icon: "✏️", message: `Product updated: ${product.name}`, user: req.user._id });
    }

    res.json(product);
  } catch (err) {
    next(err);
  }
};

// DELETE /api/products/:id  (admin)
exports.remove = async (req, res, next) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ message: "Product not found" });
    await logActivity({ type: "product", icon: "🗑️", message: `Product deleted: ${product.name}`, user: req.user._id });
    res.json({ message: "Product deleted" });
  } catch (err) {
    next(err);
  }
};
