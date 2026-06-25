const rateLimit = require("express-rate-limit");

const on = () => process.env.ENABLE_RATE_LIMIT !== "false";
const passthrough = (req, res, next) => next();

// Tight limiter for sensitive auth endpoints (login, register, refresh, verify).
const authLimiter = rateLimit({
  windowMs: Number(process.env.AUTH_RATE_WINDOW_MS || 15 * 60 * 1000), // 15 min
  max: Number(process.env.AUTH_RATE_MAX || 20),                        // 20 attempts / IP / window
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts. Please try again later." },
});

// Looser limiter usable on general API traffic if desired.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.API_RATE_MAX || 300),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests. Please slow down." },
});

// Flag-gated wrappers so the whole feature can be turned off without code changes.
module.exports = {
  authLimiter: (req, res, next) => (on() ? authLimiter(req, res, next) : passthrough(req, res, next)),
  apiLimiter: (req, res, next) => (on() ? apiLimiter(req, res, next) : passthrough(req, res, next)),
};
