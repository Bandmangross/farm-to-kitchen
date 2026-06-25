const mongoose = require("mongoose");

// Connect to MongoDB. Exits the process if the connection fails on startup.
async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("✖ MONGODB_URI is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }
  try {
    await mongoose.connect(uri);
    console.log("✔ MongoDB connected");
  } catch (err) {
    console.error("✖ MongoDB connection error:", err.message);
    process.exit(1);
  }
}

module.exports = connectDB;
