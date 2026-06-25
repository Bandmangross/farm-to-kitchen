const { parsePhoneNumberFromString } = require("libphonenumber-js");

// Parse + validate + normalize to E.164. Returns { valid, e164, country, countryCallingCode }.
function parsePhone(raw) {
  try {
    const pn = parsePhoneNumberFromString(String(raw || "").trim());
    if (!pn || !pn.isValid()) return { valid: false };
    return { valid: true, e164: pn.number, country: pn.country || "", countryCallingCode: String(pn.countryCallingCode || "") };
  } catch (_) {
    return { valid: false };
  }
}

// Mask for logs/responses: +234***789
function maskPhone(e164) {
  const s = String(e164 || "");
  if (s.length < 7) return s ? s.slice(0, 2) + "***" : "";
  return s.slice(0, 4) + "***" + s.slice(-3);
}

module.exports = { parsePhone, maskPhone };
