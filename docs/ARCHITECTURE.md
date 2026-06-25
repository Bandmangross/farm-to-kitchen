# Farm To Kitchen — Security & Identity Architecture

_Last updated: 2026-06-25 · Covers Phase 2.1 → 2.6 (Customer Identity & Security)_

This document describes the authentication, session, and account-security
architecture. It is the source of truth for how identity works in the system.
Commerce concerns (catalog, products, variants, inventory, checkout, payments,
shipping, orders, storefront UI) are intentionally **out of scope** and are not
modified by any Phase 2 work.

> **LOCKED — Phase 2.5 (Admin MFA / Admin Account Hardening).**
> The admin authentication surface is frozen. No changes to MFA enrollment,
> TOTP verification, recovery codes, admin authentication, or admin session
> handling are permitted **except bug fixes**. See [§6](#6-admin-authentication--mfa-locked).

---

## 1. Components

```
client/ (static, :3000 and :5050 fallback)
  api.js .................. single API client; SEPARATE token slots:
                            ftk_token (customer) | ftk_admin_token (admin)
  account.html ............ email-verify / phone-verify / change-password widgets
  admin.html .............. real admin login + MFA challenge / enrollment gate
  verify-email / forgot-password / reset-password .html

server/ (Express, :5050)
  server.js ............... helmet, cors(credentials), cookie-parser, trust proxy
  middleware/
    auth.js ............... protect / optionalAuth — verifies access JWT, attaches req.auth
    admin.js .............. admin-only + MFA enforcement gate
    adminEnroll.js ........ accepts admin_enroll OR full-admin token (MFA setup/enable only)
    rateLimit.js .......... per-IP authLimiter (flag-gated)
    requireVerified.js .... order gate (dormant)
  controllers/ ........... authController, adminAuthController, emailVerifyController,
                            phoneVerifyController, passwordResetController
  models/ ................ User, Session, Device, VerificationCode, AuthAuditLog (+ commerce models)
  utils/ ................. tokens, totp, recoveryCodes, email, phone, twilioVerify,
                            emailVerify, phoneVerify, hibp, passwordPolicy, device, audit,
                            adminMfaReset (ops CLI), backupDb, migrate*
```

## 2. Token model

| Token | Storage | TTL | Scope claim | Notes |
|-------|---------|-----|-------------|-------|
| Customer access | `localStorage ftk_token` | `ACCESS_TTL` (15m) | `full`, `mfa:false` | cookie-refreshed |
| Admin access | `localStorage ftk_admin_token` | `ADMIN_ACCESS_TTL` (45m) | `full`, `mfa:true` | minted **only** after MFA |
| Refresh | HttpOnly cookie `ftk_refresh` | `REFRESH_TTL_DAYS` (30d) | — | opaque; only SHA-256 hash stored in `Session` |
| `admin_enroll` (scoped) | response body, in-memory | `ADMIN_ENROLL_TTL` (15m) | `admin_enroll` | reaches MFA setup/enable **only** |
| `mfa_challenge` (scoped) | response body, in-memory | `ADMIN_CHALLENGE_TTL` (5m) | `mfa_challenge` | reaches `/admin/login/mfa` **only** |

- Access JWTs carry `{ id, role, ver, scope, mfa }`, signed with `JWT_SECRET`.
- `ver` = `user.tokenVersion`; bumping it globally revokes all access tokens
  (used by reset, MFA enable/disable, logout-all, ops reset).
- **Scope enforcement** (`middleware/auth.js`): `protect` rejects any token whose
  `scope !== "full"`. Legacy pre-2.1 tokens (no `scope`) are treated as `full`
  for back-compat. Scoped enroll/challenge tokens therefore cannot reach any
  protected API.
- Refresh rotation: each `/auth/token/refresh` revokes the presented session and
  mints a successor (`rotatedTo` chain) — refresh-token reuse is detectable.

## 3. Session & device model

- `Session` = one refresh-token lineage (hash, device, IP, UA, `expiresAt`,
  `revokedAt`, `rotatedTo`). Revocation is row-level.
- `Device` = a recognised device (`getOrIssueDeviceId` cookie), surfaced via
  `GET /me/devices`; `DELETE /me/devices/:id` revokes its sessions.
- Revocation semantics:
  - **Password reset** → revoke **all** sessions + bump `tokenVersion`.
  - **Password change** → revoke **other** sessions, rotate & keep current.
  - **MFA enable / disable / ops reset** → bump `tokenVersion` (forces re-auth).

## 4. Customer identity flows (2.2–2.4)

- **Email verification (2.2):** `VerificationCode` (link 30m + 6-digit code),
  AWS SES with dev-fallback transport, i18n-ready templates (en implemented).
  Email normalization: `emailOriginal` + `emailNormalized` (unique, sparse);
  uniqueness enforced on the normalized form.
- **Phone verification (2.3):** Twilio Verify (SMS/WhatsApp/Voice) with
  dev-fallback; libphonenumber-js E.164; one verified phone per account; OTP 10m,
  60s cooldown, 5/day cap, 5 attempts; VoIP/disposable allowed-with-friction +
  risk logging (data collection only, no enforcement this phase).
- **Password reset & change (2.4):** email-only self-service (link 30m + code 10m,
  60s cooldown, 5/day). Policy: min 12 chars, passphrases allowed, no forced
  complexity, last-5 history, **HIBP k-anonymity** breach check (fail-open on
  outage). Reset revokes **all** sessions; change keeps current. **Admins are
  excluded from self-service reset** (recovery is via the ops CLI — see Operations).

## 5. Rate limiting, audit, flags

- **Rate limiting:** per-IP `authLimiter` on all `/auth/*`, `/login`, `/register`,
  `/admin/*` routes (flag-gated by `ENABLE_RATE_LIMIT`).
- **Audit:** `AuthAuditLog` is the security audit trail (separate from the admin
  `ActivityLog`). Event enum includes login/logout, password change/reset, email
  & phone verification lifecycle, and the admin MFA events in §6.
- **Feature flags:** every Phase 2 capability is flag-gated and **defaults to
  dormant** (off). See the Deployment Checklist for the full matrix.

## 6. Admin authentication & MFA (LOCKED)

Admins authenticate **only** via `/api/admin/login` — never via `/api/login`
(customer login returns 403 for `role === "admin"`). Customer login is unchanged.

**Login state machine** (`adminAuthController.js`):

```
POST /admin/login {email,password}
  ├─ bad creds ............................. 401  (audit: admin_login_failed)
  ├─ ENABLE_ADMIN_MFA != "true" ............ full admin session (password-only; rollback/dormant)
  ├─ MFA on, not enrolled .................. { enrollmentRequired, enrollToken(admin_enroll,15m) }
  └─ MFA on, enrolled ...................... { mfaRequired, mfaToken(mfa_challenge,5m) }

POST /admin/mfa/setup  {password}     [adminEnroll]  → { secret, otpauthUrl }   (pending secret)
POST /admin/mfa/enable {password,code}[adminEnroll]  → { recoveryCodes[10] }    (shown ONCE; tokenVersion++)
POST /admin/login/mfa  {mfaToken,code}               → full admin session (mfa:true)
POST /admin/mfa/disable             {password,code}  [protect,admin]  (password + valid TOTP)
POST /admin/mfa/recovery/regenerate {password,code}  [protect,admin]
```

**Invariants (the locked contract):**

1. **TOTP secrets** are AES-256-GCM encrypted at rest (`iv:tag:enc` hex) with a
   key derived from `MFA_ENC_KEY`. Stored `select:false`. Secret/QR are returned
   to the client exactly once and **never logged**.
2. **Recovery codes:** 10 single-use codes, **bcrypt-hashed** at rest, displayed
   once. Use marks `usedAt`; reuse is rejected.
3. **An enrolled admin can never bypass MFA.** Full admin tokens carry `mfa:true`
   and are minted **only** by `startAdminSession`, which runs only after a passed
   TOTP/recovery challenge. `middleware/admin.js` rejects an enrolled admin's
   request when `mfa` is absent (`403 MFA_REQUIRED`).
4. **Re-auth required:** setup/enable/disable/regenerate all require the current
   password; disable & regenerate additionally require a valid TOTP.
5. **Lockout:** `ADMIN_MFA_MAX_ATTEMPTS` (5) failed challenges → `ADMIN_MFA_LOCK_MS`
   (15m) lock (`mfaLockUntil`).
6. **Audit (all admin MFA events):** `admin_login`, `admin_login_failed`,
   `admin_mfa_setup`, `admin_mfa_enabled`, `admin_mfa_disabled`,
   `admin_mfa_challenge_failed`, `admin_recovery_used`,
   `admin_recovery_regenerated`, `admin_mfa_reset`.
7. **Never locked out:** with `ENABLE_ADMIN_MFA` off, admin login is password-only
   (no enrollment, no lockout). With it on, an un-enrolled admin is forced to
   enroll (not blocked). The ops CLI can always recover a stuck admin.
8. **No client credential persistence:** `admin.html` stores only the admin token;
   the legacy `farmadmin` gate password and stored API credentials were removed.

`User` MFA fields (all `select:false` where sensitive): `mfaEnabled`,
`mfaSecret`, `mfaPendingSecret`, `mfaEnrolledAt`, `recoveryCodes[{codeHash,usedAt}]`,
`mfaFailedAttempts`, `mfaLockUntil`.

## 6b. Customer session & device management + login alerts (Phase 2.6)

Customer-facing visibility and control over their own sessions/devices, plus a
new-sign-in alert. Reuses the existing `Device`/`Session`/`AuthAuditLog`/email
infrastructure. **No impact on the locked admin-auth surface** — admin login uses
its own `startAdminSession` path and never calls `loginDevice`.

- **Coarse geo-IP** (`utils/geoip.js`): offline `geoip-lite`, **city/country only**
  (never lat/long); private/loopback and missing-DB → "Unknown location". No
  external network calls.
- **Anomaly detection** (`utils/device.js → loginDevice`): on a successful
  **customer** login, reads the prior device record before upserting and reports
  `isNewDevice` / `isNewLocation`. New location only flags for a known active
  device whose coarse country/city changed **and** a country actually resolved
  (never alerts on Unknown→Unknown). Stamps `lastLoginAt` + coarse geo on `Device`.
- **Login alert** (flag `ENABLE_LOGIN_ALERTS`, default off): new device **or** new
  location → i18n-ready `newDeviceLogin` email (en) + `new_device_login` audit.
  Best-effort; never blocks login. Not sent on registration.
- **Endpoints** (flag `ENABLE_SESSION_UI`, default off → 404 when off):
  - `GET /me/sessions` — active sessions w/ device, IP, coarse location,
    **last-seen**, and a `current` flag.
  - `POST /me/sessions/revoke-all` — sign out everywhere; **requires password
    re-entry**; bumps `tokenVersion` + revokes all sessions/devices (kills the
    calling session too → audit `all_sessions_revoked`).
  - `GET /me/devices` (pre-existing, enriched additively): adds coarse `location`,
    `lastLoginAt`, `current`; `lastSeenAt` already present.
  - `DELETE /me/devices/:id` (pre-existing): now audits `session_revoked`.
- **New `Device` fields:** `lastLoginAt`, `approxCity`, `approxCountry` (coarse).
- **New audit events:** `new_device_login`, `session_revoked`, `all_sessions_revoked`.
- **Client:** `account.html` "Devices & sign-in activity" panel + `api.js`
  `API.sessions.*`. Falls back to `/me/devices` when `ENABLE_SESSION_UI` is off.

## 7. Rollback posture

Every Phase 2 capability is reversible by flag. Disabling `ENABLE_ADMIN_MFA`
returns admin login to password-only **without locking anyone out**; the MFA
fields and audit-enum additions are additive and inert when the flag is off.
See the Operations Recovery Procedure for the step-by-step rollback drill.

## 8. Commerce integrity & checkout hardening (Phase 3)

Money/inventory correctness for orders, payments, and the admin back-office. All
behind default-off flags; see [PHASE_3_DESIGN.md](./PHASE_3_DESIGN.md) for the full
design. Identity/Phase 2.5 admin auth is unchanged — admin endpoints reuse the
existing `protect, admin` guard.

- **Server-authoritative pricing:** `POST /orders` re-prices every line from the DB
  (`controllers/orderController.js → repriceLines`); client price/total/paid-state
  are ignored. Atomic gap-free order IDs via a `Counter`.
- **Reserve → commit inventory** (`utils/inventory.js`): `available = stock −
  reserved`. Create reserves (atomic conditional `$inc` under a MongoDB transaction);
  verified payment commits (`reserved → stock`); cancel/expiry/manual-release frees;
  refund restores. Every movement is an immutable `StockLedger` row (unique per
  order+type+line = idempotency). Concurrency-safe: exactly one reservation wins the
  last unit (no oversell).
- **Payment verification** (`controllers/paymentController.js`, `utils/paystack.js`):
  mandatory Paystack `verify`; amount checked in **kobo** + currency against the
  server total; idempotent on `reference`/already-paid; every attempt logged to
  `PaymentEvent`. Simulation only behind `ALLOW_SIMULATED_PAYMENTS` (dev). A
  signature-verified **webhook** (HMAC-SHA512, raw body) and a reconciliation job are
  the settlement safety net.
- **Order lifecycle** (`utils/orderState.js`): a single state machine —
  Awaiting Payment → (cancel) Cancelled; Paid → Processing → Shipped → Delivered;
  Paid/…/Delivered → (refund) Refunded. Illegal transitions 409; each appends
  `statusHistory`; payment (→ Paid) reachable only via verified settlement.
- **Admin Orders Dashboard** (`routes/admin.js`, `controllers/adminOrdersController.js`):
  `/api/admin/*` reads (orders w/ filter+search, payment timeline, inventory
  movements) and actions (cancel / refund / manual release) — each requires a reason
  and writes a `CommerceAuditLog` entry. Manual release frees the reservation and
  keeps the order Awaiting Payment (no auto-cancel).
- **New collections:** `counters`, `stockledgers`, `paymentevents`,
  `commerceauditlogs`. **New flags:** `ENABLE_COMMERCE_INTEGRITY`,
  `ENABLE_PAYMENT_WEBHOOK`, `ALLOW_SIMULATED_PAYMENTS`,
  `ENABLE_ADMIN_ORDERS_DASHBOARD`, `ENABLE_GATEWAY_REFUND`.
