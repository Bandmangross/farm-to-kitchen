# Farm To Kitchen — Operations & Recovery Procedure

_Last updated: 2026-06-25 · Through Phase 2.6_

Runbook for security/identity incidents. Pairs with
[ARCHITECTURE.md](./ARCHITECTURE.md) and [DEPLOYMENT_CHECKLIST.md](./DEPLOYMENT_CHECKLIST.md).
All commands run from `server/` with production env loaded. **Take a DB backup
before any destructive action:** `node utils/backupDb.js`.

---

## 1. Admin locked out of MFA (lost authenticator **and** recovery codes)

This is the primary admin-recovery path. Requires server/DB access (ops only).

```bash
node utils/adminMfaReset.js <admin-email>
```

Effect: disables MFA for that admin, wipes `mfaSecret` / `mfaPendingSecret` /
`recoveryCodes`, clears lock counters, bumps `tokenVersion` (kills active admin
sessions), and writes an `admin_mfa_reset` audit event. The admin is **forced to
re-enroll** on their next `/admin/login`.

- [ ] Confirm the requester's identity out-of-band before running.
- [ ] After reset, have the admin re-enroll and **securely store the new 10
      recovery codes** (shown once).
- [ ] Verify the `admin_mfa_reset` event landed in `AuthAuditLog`.

## 2. Admin temporarily MFA-locked (too many bad codes)

A 6th wrong code triggers a `ADMIN_MFA_LOCK_MS` (15m) lock (`mfaLockUntil`),
returning `429`. Options:

- **Wait** for the lock to expire (preferred — it's working as designed), or
- If urgent, run the **§1 reset** to clear the lock and re-enroll.

## 3. Admin lost authenticator but **has** recovery codes

No ops action needed. At `/admin/login` → enter a recovery code instead of a TOTP
at the MFA challenge. Each code is single-use (`admin_recovery_used` audited).
Afterwards, the admin should **regenerate codes** and re-add an authenticator:

```
POST /admin/mfa/recovery/regenerate   { password, code }   # invalidates old codes
```

## 4. Suspected admin compromise

1. [ ] `node utils/adminMfaReset.js <email>` — kills sessions + forces re-enroll.
2. [ ] Rotate the admin password (admin self-service change, or reseed).
3. [ ] If broad compromise suspected, rotate `JWT_SECRET` (logs **everyone** out)
       and/or rotate `MFA_ENC_KEY` (then **all** admins must re-enroll via §1).
4. [ ] Review `AuthAuditLog` for `admin_login`, `admin_login_failed`,
       `admin_mfa_challenge_failed`, `admin_recovery_used` around the window.

## 5. Customer account recovery

- **Forgot password:** self-service at `/forgot-password.html` (link 30m / code
  10m). Requires `ENABLE_PASSWORD_RESET=true`. Reset revokes **all** sessions.
- **Locked out (failed logins):** auto-clears after `LOGIN_LOCK_MS` (15m).
- **Admins are excluded from self-service reset** — use §1/§4 instead.

## 5b. Customer suspicious-login / session management (Phase 2.6)

- **Customer reports an unrecognized sign-in alert:** advise them to (1) change
  their password (revokes all sessions) and (2) use **Account → Security → Sign
  out of all devices** (`POST /me/sessions/revoke-all`, requires password). This
  bumps `tokenVersion`, killing every session including the current one.
- **Review:** `AuthAuditLog` events `new_device_login` (with `reason` =
  New device / New location + coarse `location`), `session_revoked`,
  `all_sessions_revoked`.
- **Alerts not firing / wrong location:** confirm `ENABLE_LOGIN_ALERTS=true`, the
  email layer is configured, and the proxy sends correct `X-Forwarded-For`. Coarse
  location is best-effort; "Unknown location" is expected for private/loopback IPs
  or a stale/missing `geoip-lite` DB — refresh it
  (`node node_modules/geoip-lite/scripts/updatedb.js`).
- **Rollback:** turn off `ENABLE_SESSION_UI` and `ENABLE_LOGIN_ALERTS`; the new
  endpoints return 404 and no alerts are sent. Added `Device` fields / audit-enum
  values are inert. `GET/DELETE /me/devices` continue to work.

## 6. Lost / rotated `MFA_ENC_KEY`

Existing encrypted TOTP secrets become undecryptable. Recovery:

1. [ ] Set the new `MFA_ENC_KEY` and restart.
2. [ ] For each admin: `node utils/adminMfaReset.js <email>` → they re-enroll.

> Keep `MFA_ENC_KEY` in a vault with the same care as `JWT_SECRET`. Back it up
> independently of the database.

## 7. Rollback drill — disable admin MFA

Reversible by flag; **never locks the admin out**.

1. [ ] Set `ENABLE_ADMIN_MFA` off (unset or `false`) and restart production-safe.
2. [ ] Verify `/admin/login` now issues a full admin token **password-only**
       (no enrollment, no challenge, no lockout) and reaches an admin API (200).
3. [ ] MFA fields/audit-enum additions remain in place but inert.
4. [ ] To re-enable later, follow Deployment Checklist §4.

To roll back other phases, turn off the matching `ENABLE_*` flag — additive
schema fields are inert when their flag is off.

## 8. Database backup & restore

- **Backup (always before changes):** `node utils/backupDb.js` →
  `backups/<ISO-timestamp>/`.
- **Restore:** stop the app, restore the chosen `backups/<timestamp>/` snapshot
  into the target database, restart, then run §9 verification.

## 9. Post-incident verification

- [ ] Affected admin/customer can authenticate (admin via MFA if enforced).
- [ ] `AuthAuditLog` shows the expected recovery/reset events.
- [ ] Customer login unaffected; `/api/login` still returns 403 for admins.
- [ ] Commerce regression: public products list + images intact; key pages 200.
- [ ] Resting flag set matches intent; no dev-echo / `ENABLE_RATE_LIMIT=false`
      left enabled.

## 10. Escalation / on-call notes

- Any change touching MFA enrollment, TOTP verification, recovery codes, admin
  authentication, or admin session handling is **frozen (Phase 2.5 LOCKED)** and
  permitted **only as a bug fix** — see ARCHITECTURE §6. Operational recovery
  uses the CLI and flags above, **not** code changes.
