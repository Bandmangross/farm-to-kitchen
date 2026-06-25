# Farm To Kitchen — Deployment Checklist

_Last updated: 2026-06-25 · Through Phase 2.6_

Use this checklist for every production deploy. It assumes the architecture in
[ARCHITECTURE.md](./ARCHITECTURE.md). Commerce subsystems (catalog, checkout,
payments, shipping, orders) are unaffected by Phase 2 and are not covered here.

---

## 0. Pre-deploy

- [ ] **Backup the database first** — `node utils/backupDb.js` (writes to `backups/<timestamp>/`).
- [ ] Confirm the target Node version (**18+**) and `npm ci` in `server/`.
- [ ] Run the seed if needed (idempotent): `npm run seed`.
- [ ] Confirm `git`/release tag matches the intended build.

## 1. Core environment (required)

| Var | Purpose | Production note |
|-----|---------|-----------------|
| `MONGODB_URI` | Atlas connection | restricted network/user |
| `JWT_SECRET` | signs access + scoped tokens | long random; rotating it logs everyone out |
| `NODE_ENV=production` | enables Secure cookies | **required** for `Secure` flag |
| `PORT` | API port (5050) | |
| `CLIENT_ORIGIN` | CORS allow-list origin | exact HTTPS origin |
| `APP_URL` | base for emailed reset/verify links | HTTPS |
| `PAYSTACK_SECRET_KEY` | payments (unchanged) | |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | initial admin | **rotate the seeded password before go-live** |

## 2. Token / session tuning (optional; defaults shown)

`ACCESS_TTL=15m` · `ADMIN_ACCESS_TTL=45m` · `REFRESH_TTL_DAYS=30` ·
`MAX_FAILED_LOGINS=5` · `LOGIN_LOCK_MS=900000`

## 3. Feature flags — **all default OFF / dormant**

Enable deliberately, one capability at a time, verifying after each.

| Flag | Capability | Default |
|------|-----------|---------|
| `ENABLE_REFRESH_TOKENS` | refresh-cookie sessions | on unless `"false"` |
| `ENABLE_LOCKOUT` | login lockout | on unless `"false"` |
| `ENABLE_RATE_LIMIT` | per-IP auth rate limiting | **keep ON in prod** |
| `ENABLE_DEVICE_TRACKING` | device records | |
| `ENABLE_AUDIT` | AuthAuditLog writes | **keep ON in prod** |
| `ENABLE_EMAIL` | real SES send (else dev transport) | |
| `ENABLE_EMAIL_VERIFICATION` | email verify flow | |
| `ENABLE_PHONE_VERIFICATION` | Twilio Verify flow | |
| `ENABLE_PASSWORD_RESET` | self-service reset/change | |
| `ENABLE_ADMIN_MFA` | **admin MFA enforcement** | see §4 |
| `ENABLE_LOGIN_ALERTS` | new-device / new-location email alert | Phase 2.6 |
| `ENABLE_SESSION_UI` | `/me/sessions` + sign-out-everywhere | Phase 2.6 |
| `ENABLE_COMMERCE_INTEGRITY` | server re-pricing + reserve/commit inventory + hardened confirm | Phase 3 |
| `ENABLE_PAYMENT_WEBHOOK` | signature-verified Paystack webhook | Phase 3 |
| `ALLOW_SIMULATED_PAYMENTS` | **dev-only** simulated payment path | Phase 3 — **OFF in prod** |
| `ENABLE_ADMIN_ORDERS_DASHBOARD` | `/api/admin/*` orders dashboard | Phase 3 |
| `ENABLE_GATEWAY_REFUND` | real Paystack refund on admin refund | Phase 3 — off until reconciled |
| `ENABLE_ORDER_VERIFICATION_GATE` | order gate (dormant) | leave off unless intended |

> **Dev-echo flags must be OFF in prod:** `EMAIL_DEV_ECHO`, `PHONE_DEV_ECHO`,
> `PWRESET_DEV_ECHO`, `PHONE_DEV_VOIP`. These leak codes/links into responses.

## 4. Admin MFA go-live (Phase 2.5)

- [ ] Set **`MFA_ENC_KEY`** to a ≥32-byte high-entropy secret, stored in a vault.
      _Losing/rotating this key makes existing TOTP secrets undecryptable — all
      admins must re-enroll via the ops reset CLI._
- [ ] (Optional) `MFA_ISSUER` (authenticator label), `ADMIN_MFA_MAX_ATTEMPTS=5`,
      `ADMIN_MFA_LOCK_MS=900000`, `ADMIN_ENROLL_TTL=15m`, `ADMIN_CHALLENGE_TTL=5m`.
- [ ] Set **`ENABLE_ADMIN_MFA=true`**.
- [ ] First admin sign-in at `/admin/login` returns `enrollmentRequired` →
      complete TOTP enrollment → **securely store the 10 recovery codes** (shown once).
- [ ] **Rotate the seeded admin password** (`admin1234`) if not already done.
- [ ] Verify a fresh admin login requires TOTP and reaches an admin API (e.g. `/orders` 200).
- [ ] Confirm `/api/login` returns **403** for the admin (admins use the portal only).

## 4b. Session management & login alerts go-live (Phase 2.6)

- [ ] `geoip-lite` is installed (`npm ci` pulls it). Coarse **city/country only**,
      fully offline — no external geo calls. Missing DB → location shows "Unknown"
      (feature still works; alerts trigger on new device).
- [ ] Set `ENABLE_SESSION_UI=true` to expose `GET /me/sessions` and
      `POST /me/sessions/revoke-all` (sign out everywhere; **requires password
      re-entry**). `GET/DELETE /me/devices` work regardless.
- [ ] Set `ENABLE_LOGIN_ALERTS=true` to email customers on a **new device OR new
      approximate location** sign-in (requires the email layer — §5).
- [ ] Confirm `trust proxy` + correct `X-Forwarded-For` so client IPs resolve to
      the right coarse location behind your load balancer.
- [ ] `geoip-lite` ships a point-in-time DB; refresh periodically
      (`node node_modules/geoip-lite/scripts/updatedb.js`) to keep lookups current.

## 4c. Commerce integrity & checkout hardening go-live (Phase 3)

Staged cutover — enable one flag at a time and verify after each.

- [ ] Run the additive backfill once: `node utils/migrateCommerce.js` (idempotent;
      also creates the new collections + indexes so transactional writes work).
- [ ] Confirm Atlas is a **replica set** (multi-document transactions are required).
- [ ] `ENABLE_COMMERCE_INTEGRITY=true` → orders re-price server-side, reserve stock
      (TTL `RESERVATION_TTL_MIN`, default 30), and settle via a transactional commit;
      boot starts the **reservation sweeper** + **reconciliation** jobs. Tune
      `DEFAULT_DELIVERY_FEE`, `RESERVATION_SWEEP_INTERVAL_MS`, `RECONCILE_INTERVAL_MS`.
- [ ] `ENABLE_PAYMENT_WEBHOOK=true` → register the webhook URL
      `POST /api/payments/webhook` in the Paystack dashboard (signature = HMAC-SHA512
      over the raw body, keyed by `PAYSTACK_SECRET_KEY`). The client passes
      `metadata.orderId` so the webhook can correlate the charge.
- [ ] `ALLOW_SIMULATED_PAYMENTS` **must be OFF** in production (dev/testing only).
- [ ] `ENABLE_ADMIN_ORDERS_DASHBOARD=true` → exposes `/api/admin/*` (behind
      `protect, admin`; MFA enforced when admin MFA is on).
- [ ] `ENABLE_GATEWAY_REFUND` last, only after reconciling with your Paystack refund
      policy (off → admin refund is local: `Refunded` + stock restore + audit).
- [ ] Real `PAYSTACK_SECRET_KEY` set (no `xxxx` placeholder).

## 5. Email / SMS providers (if enabling 2.2 / 2.3)

- [ ] SES: `AWS_REGION`, `SES_FROM` (verified identity), IAM send permission.
      Tune `EMAIL_VERIFY_TTL_HOURS`, `EMAIL_RESEND_COOLDOWN_SEC`,
      `EMAIL_DAILY_CAP`, `EMAIL_CODE_MAX_ATTEMPTS`.
- [ ] Twilio: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
      `TWILIO_VERIFY_SERVICE_SID`, `TWILIO_LOOKUP_ENABLED`. Tune `PHONE_OTP_TTL_MS`,
      `PHONE_RESEND_COOLDOWN_SEC`, `PHONE_DAILY_CAP`, `PHONE_CODE_MAX_ATTEMPTS`.
- [ ] HIBP (2.4): `HIBP_ENABLED=true`, `HIBP_FAIL_OPEN=true` (recommended).
- [ ] Password policy: `PASSWORD_MIN_LEN=12`, `PASSWORD_HISTORY=5`.

## 6. Transport & cookies

- [ ] Serve over **HTTPS** behind a trusted proxy; `trust proxy` is set so client
      IPs and `Secure` cookies work.
- [ ] Confirm `Set-Cookie` for `ftk_refresh` is `HttpOnly; SameSite=Lax; Secure`
      in prod.
- [ ] CORS: `credentials: true` with `CLIENT_ORIGIN` exactly matching the frontend.

## 7. Post-deploy smoke test

- [ ] Customer register → login → `/me` 200; logout revokes session.
- [ ] Admin `/admin/login` enforces MFA (if enabled) and reaches an admin API.
- [ ] Public products list returns the expected catalog with images (commerce regression).
- [ ] `index.html`, `admin.html`, `account.html` all return 200.
- [ ] AuthAuditLog is receiving events; rate limiting is active.

## 8. Production-safe restart

- [ ] Restart with the **intended flag set only** (no dev-echo, no
      `ENABLE_RATE_LIMIT=false`).
- [ ] Confirm the resting state matches intent (e.g. admin MFA enforced **or**
      deliberately dormant) before declaring the deploy complete.
