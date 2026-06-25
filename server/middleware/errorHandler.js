// Centralised error handler. Converts duplicate-key and validation errors to clean messages.
module.exports = function errorHandler(err, req, res, next) {
  console.error(err);

  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || "field";
    return res.status(409).json({ message: `${field} already exists` });
  }
  if (err.name === "ValidationError") {
    const msg = Object.values(err.errors).map((e) => e.message).join(", ");
    return res.status(400).json({ message: msg });
  }

  res.status(err.status || 500).json({ message: err.message || "Server error" });
};
