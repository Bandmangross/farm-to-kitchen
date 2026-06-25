const crypto = require("crypto");

// HaveIBeenPwned breach check via k-anonymity: only the first 5 chars of the SHA-1
// hash leave the server; the password/full hash NEVER does. Fail-open by default so
// an HIBP outage can't block password resets (logged).
const FAIL_OPEN = process.env.HIBP_FAIL_OPEN !== "false";

async function isBreached(password) {
  if (process.env.HIBP_ENABLED === "false") return false;
  try {
    const hash = crypto.createHash("sha1").update(String(password)).digest("hex").toUpperCase();
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    const res = await fetch("https://api.pwnedpasswords.com/range/" + prefix, { headers: { "Add-Padding": "true" } });
    if (!res.ok) { console.warn("[HIBP] non-OK response " + res.status); return FAIL_OPEN ? false : true; }
    const text = await res.text();
    return text.split("\n").some((line) => line.split(":")[0].trim().toUpperCase() === suffix);
  } catch (e) {
    console.warn("[HIBP] lookup failed (" + (FAIL_OPEN ? "fail-open" : "fail-closed") + "): " + e.message);
    return FAIL_OPEN ? false : true;
  }
}

module.exports = { isBreached };
