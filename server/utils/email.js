// Email layer: address normalization + AWS SES sending + i18n-ready templates.
// SES is used when configured; otherwise a DEV transport logs the message (so the
// flow is fully testable without real credentials). Only EN is implemented now;
// fr/es/de/pt/ar fall back to EN until translated.

// ── Normalization ──
// Canonical form for de-duplication: lowercase, strip +tags, and (for Gmail) drop
// dots. The ORIGINAL address is what we actually send to.
function normalizeEmail(raw) {
  const e = String(raw || "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  local = local.split("+")[0];
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return local + "@" + domain;
}

// ── i18n-ready templates ──
const LANGS = ["en", "fr", "es", "de", "pt", "ar"];
const templates = {
  verification: {
    en: {
      subject: "Verify your Farm To Kitchen email",
      text: ({ link, code }) =>
        `Welcome to Farm To Kitchen!\n\nVerify your email:\n${link}\n\nOr enter this 6-digit code: ${code}\n\nThis link and code expire in 24 hours. If you didn't sign up, you can ignore this email.`,
      html: ({ link, code }) =>
        `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto;color:#1a1a1a">
          <h2 style="color:#0b7a34;margin:0 0 8px">Verify your email</h2>
          <p>Welcome to <b>Farm To Kitchen</b>. Confirm your email to activate your account.</p>
          <p style="margin:22px 0"><a href="${link}" style="display:inline-block;background:#1f7a3f;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Verify Email</a></p>
          <p>Or enter this code: <b style="font-size:22px;letter-spacing:4px">${code}</b></p>
          <p style="color:#8a9097;font-size:12px;margin-top:20px">This link and code expire in 24 hours. If you didn't sign up, you can ignore this email.</p>
        </div>`,
    },
    fr: null, es: null, de: null, pt: null, ar: null, // future translations
  },
  passwordReset: {
    en: {
      subject: "Reset your Farm To Kitchen password",
      text: ({ link, code }) =>
        `We received a request to reset your password.\n\nReset link (valid 30 minutes):\n${link}\n\nOr use this 6-digit code (valid 10 minutes): ${code}\n\nIf you didn't request this, you can ignore this email — your password is unchanged.`,
      html: ({ link, code }) =>
        `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto;color:#1a1a1a">
          <h2 style="color:#0b7a34;margin:0 0 8px">Reset your password</h2>
          <p>We received a request to reset your Farm To Kitchen password.</p>
          <p style="margin:22px 0"><a href="${link}" style="display:inline-block;background:#1f7a3f;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Reset Password</a></p>
          <p style="font-size:13px;color:#666">Link valid for 30 minutes. Or use this code (valid 10 minutes): <b style="font-size:20px;letter-spacing:4px">${code}</b></p>
          <p style="color:#8a9097;font-size:12px;margin-top:20px">If you didn't request this, ignore this email — your password is unchanged.</p>
        </div>`,
    },
    fr: null, es: null, de: null, pt: null, ar: null,
  },
  passwordChanged: {
    en: {
      subject: "Your Farm To Kitchen password was changed",
      text: ({ reason }) =>
        `Your password was just ${reason === "reset" ? "reset" : "changed"}. If this wasn't you, please contact support immediately and secure your account.`,
      html: ({ reason }) =>
        `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto;color:#1a1a1a">
          <h2 style="color:#0b7a34;margin:0 0 8px">Password ${reason === "reset" ? "reset" : "changed"}</h2>
          <p>Your Farm To Kitchen password was just ${reason === "reset" ? "reset" : "changed"}.</p>
          <p style="color:#c0392b;font-size:13px">If this wasn't you, contact support immediately and secure your account.</p>
        </div>`,
    },
    fr: null, es: null, de: null, pt: null, ar: null,
  },
  // Phase 2.6 — login-anomaly alert (new device or new approximate location).
  newDeviceLogin: {
    en: {
      subject: "New sign-in to your Farm To Kitchen account",
      text: ({ when, device, location, ip, reason }) =>
        `We noticed a new sign-in to your Farm To Kitchen account.\n\n` +
        `When: ${when}\nDevice: ${device}\nApprox. location: ${location}\nIP: ${ip}\n` +
        `Reason: ${reason}\n\n` +
        `If this was you, no action is needed. If you don't recognize this, change your ` +
        `password and sign out of all devices from Account → Security.`,
      html: ({ when, device, location, ip, reason }) =>
        `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto;color:#1a1a1a">
          <h2 style="color:#0b7a34;margin:0 0 8px">New sign-in detected</h2>
          <p>We noticed a new sign-in to your <b>Farm To Kitchen</b> account.</p>
          <table style="font-size:14px;border-collapse:collapse;margin:14px 0">
            <tr><td style="color:#667;padding:2px 10px 2px 0">When</td><td><b>${when}</b></td></tr>
            <tr><td style="color:#667;padding:2px 10px 2px 0">Device</td><td><b>${device}</b></td></tr>
            <tr><td style="color:#667;padding:2px 10px 2px 0">Approx. location</td><td><b>${location}</b></td></tr>
            <tr><td style="color:#667;padding:2px 10px 2px 0">IP</td><td><b>${ip}</b></td></tr>
            <tr><td style="color:#667;padding:2px 10px 2px 0">Reason</td><td><b>${reason}</b></td></tr>
          </table>
          <p style="font-size:13px">If this was you, no action is needed.</p>
          <p style="color:#c0392b;font-size:13px">If you don't recognize this, change your password and use
          <b>Sign out of all devices</b> in Account → Security.</p>
        </div>`,
    },
    fr: null, es: null, de: null, pt: null, ar: null, // future translations
  },
  // Phase 5.1 — order confirmation (sent after a successful PAID order).
  orderConfirmation: {
    en: {
      subject: "Your Farm To Kitchen order is confirmed",
      text: ({ orderId, customerName, total, items }) =>
        `Hi ${customerName || "there"},\n\nThanks for your order — payment received and your order is confirmed.\n\n` +
        `Order: ${orderId}\n` +
        (Array.isArray(items)
          ? items.map((it) => `  - ${it.name} (${it.quantity || 1}) — NGN ${Number(it.price || 0).toLocaleString()}`).join("\n") + "\n"
          : "") +
        `\nTotal paid: NGN ${Number(total || 0).toLocaleString()}\n\nWe'll let you know when it ships. Thank you for shopping with Farm To Kitchen!`,
      html: ({ orderId, customerName, total, items }) =>
        `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:auto;color:#1a1a1a">
          <h2 style="color:#0b7a34;margin:0 0 8px">Order confirmed 🎉</h2>
          <p>Hi ${customerName || "there"}, thanks for your order — payment received and your order is confirmed.</p>
          <p style="margin:6px 0"><b>Order:</b> ${orderId}</p>
          <table style="font-size:14px;border-collapse:collapse;width:100%;margin:12px 0">
            ${(Array.isArray(items) ? items : []).map((it) =>
              `<tr><td style="padding:4px 0;border-bottom:1px solid #eee">${it.name} <span style="color:#667">(${it.quantity || 1})</span></td>
                   <td style="padding:4px 0;border-bottom:1px solid #eee;text-align:right">NGN ${Number(it.price || 0).toLocaleString()}</td></tr>`
            ).join("")}
          </table>
          <p style="font-size:16px"><b>Total paid: NGN ${Number(total || 0).toLocaleString()}</b></p>
          <p style="color:#8a9097;font-size:12px;margin-top:18px">We'll email you when it ships. Thank you for shopping with Farm To Kitchen!</p>
        </div>`,
    },
    fr: null, es: null, de: null, pt: null, ar: null, // future translations
  },
};
function getTemplate(name, lang) {
  const t = templates[name] || {};
  return t[lang] || t.en; // graceful fallback to English
}

// ── AWS SES transport (lazy). Used ONLY as a fallback when RESEND_API_KEY is absent.
// Resend now sends over its HTTP API (see deliver) to avoid blocked SMTP ports. ──
let _transport = null;
let _resolved = false;
function getTransport() {
  if (_resolved) return _transport;
  _resolved = true;
  if (process.env.AWS_REGION && process.env.SES_FROM) {
    try {
      const nodemailer = require("nodemailer");
      const aws = require("@aws-sdk/client-ses");
      const ses = new aws.SESClient({ region: process.env.AWS_REGION });
      _transport = nodemailer.createTransport({ SES: { ses, aws } });
      console.log("[Email] AWS SES transport ready (region " + process.env.AWS_REGION + ")");
    } catch (e) {
      console.warn("[Email] SES init failed, using DEV transport:", e.message);
      _transport = null;
    }
  }
  return _transport;
}

// Sender address: EMAIL_FROM (Resend) → SES_FROM (legacy) → dev fallback.
function fromAddr() {
  return process.env.EMAIL_FROM || process.env.SES_FROM || "no-reply@farmtokitchen.local";
}

// Core delivery. Provider order: Resend HTTP API (RESEND_API_KEY) → AWS SES → DEV log.
// Throws on a hard provider failure so callers' best-effort try/catch can record it;
// returns { sent:false } when suppressed or when no provider is configured.
async function deliver({ to, subject, text, html }) {
  const from = fromAddr();
  if (process.env.ENABLE_EMAIL === "false") {
    console.log("[Email] suppressed (ENABLE_EMAIL=false) → " + to);
    return { sent: false, reason: "disabled" };
  }

  // Resend HTTP API (preferred — avoids blocked outbound SMTP ports).
  if (process.env.RESEND_API_KEY) {
    let resp;
    try {
      resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + process.env.RESEND_API_KEY, // key never logged
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from, to, subject, text, html }),
      });
    } catch (e) {
      console.error(`[Email] Resend API request FAILED → ${to}: ${e.message}`);
      throw e;
    }
    if (!resp.ok) {
      let detail = ""; try { detail = await resp.text(); } catch (_) {}
      console.error(`[Email] Resend API send FAILED → ${to} (HTTP ${resp.status}) ${detail}`);
      const err = new Error("Resend API error " + resp.status);
      err.status = resp.status;
      throw err;
    }
    let id = ""; try { id = (await resp.json()).id || ""; } catch (_) {}
    console.log(`[Email] Resend API sent → ${to} (id ${id})`);
    return { sent: true, id };
  }

  // AWS SES fallback (only when RESEND_API_KEY is missing).
  const transport = getTransport();
  if (transport) {
    await transport.sendMail({ from, to, subject, text, html });
    console.log("[Email] SES sent → " + to);
    return { sent: true };
  }

  // DEV fallback — no email provider configured.
  console.log(`[Email:DEV] to=${to} subject="${subject}" (no email provider configured)`);
  return { sent: false, reason: "dev" };
}

async function sendVerificationEmail({ to, link, code, lang = "en" }) {
  const tpl = getTemplate("verification", lang);
  return deliver({ to, subject: tpl.subject, text: tpl.text({ link, code }), html: tpl.html({ link, code }) });
}

async function sendTemplate(name, { to, lang = "en", data = {} }) {
  const tpl = getTemplate(name, lang);
  return deliver({ to, subject: tpl.subject, text: tpl.text(data), html: tpl.html(data) });
}
function sendResetEmail({ to, link, code, lang }) { return sendTemplate("passwordReset", { to, lang, data: { link, code } }); }
function sendPasswordChangedEmail({ to, lang, reason }) { return sendTemplate("passwordChanged", { to, lang, data: { reason } }); }
function sendNewDeviceLoginEmail({ to, lang, data }) { return sendTemplate("newDeviceLogin", { to, lang, data }); }
function sendOrderConfirmationEmail({ to, lang, data }) { return sendTemplate("orderConfirmation", { to, lang, data }); }

module.exports = { normalizeEmail, sendVerificationEmail, sendResetEmail, sendPasswordChangedEmail, sendNewDeviceLoginEmail, sendOrderConfirmationEmail, getTemplate, LANGS };
