const mongoose = require("mongoose");

// Atomic, gap-free sequence source. One doc per sequence (e.g. "order-2026").
// nextSeq() uses a single atomic findOneAndUpdate($inc) — no read-then-write race
// (fixes the order-ID collision risk R8).
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

counterSchema.statics.nextSeq = async function (key, session = null) {
  const doc = await this.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, ...(session ? { session } : {}) }
  );
  return doc.seq;
};

module.exports = mongoose.model("Counter", counterSchema);
