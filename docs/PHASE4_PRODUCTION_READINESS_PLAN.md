# Phase 4 — Production Readiness & Launch Plan

_Owner: Platform Engineering · Status: **PLAN (no code)** · 2026-06-25_
_Scope: take Farm To Kitchen from a verified, flag-dormant build to a live,
internet-facing production launch. Documentation only — no application code, no
Phase 3 flag changes._

---

## 1. Current application state

- **Architecture:** Node.js + Express + Mongoose API on `:5050`; static client
  (`client/`) served by the API and/or a separate static host. MongoDB Atlas via
  `MONGODB_URI`. Payments via Paystack (server-side verify). Email via AWS SES
  (dev-fallback transport when unconfigured); SMS via Twilio Verify; coarse geo via
  offline `geoip-lite`.
- **Security/identity (Phases 2.1–2.6, implemented):** short-lived JWT access +
  rotating refresh cookies, tokenVersion revocation, device tracking, audit log,
  email + phone verification, password reset/HIBP/policy, **admin TOTP MFA**
  (dormant), session/device management + login alerts (dormant).
- **Commerce (Phase 3, implemented, dormant):** server-authoritative pricing,
  reserve/commit inventory under transactions, hardened idempotent payment verify +
  signature webhook, order state machine, admin orders dashboard, `CommerceAuditLog`.
- **Resting posture:** all Phase 2.2+ and Phase 3 capabilities are **flag-OFF /
  dormant**. `NODE_ENV` is not `production` (Secure cookies off). Seeded admin
  password not rotated. Real SES/Twilio/Paystack credentials not yet wired.
- **Git:** `master` @ `9c8772e`; tags `pre-phase3`, `phase3-verified`,
  `phase3-runbook`, `phase3-completion-report`.

> **Bottom line:** the platform is feature-complete for v1 but configured for local
> dev. Phase 4 is an infrastructure, configuration, and activation effort — not a
> feature build.

## 2. Phase 3 completion summary

- Implemented + verified (M1–M8), committed `9139b75` / tag `phase3-verified`; full
  evidence in `PHASE3_COMPLETION_REPORT.md`; activation steps in
  `PHASE3_ACTIVATION_RUNBOOK.md`.
- New collections: `counters`, `stockledgers`, `paymentevents`, `commerceauditlogs`
  (additive; indexes built; inert when flags off).
- Flags (default OFF): `ENABLE_COMMERCE_INTEGRITY`, `ENABLE_PAYMENT_WEBHOOK`,
  `ALLOW_SIMULATED_PAYMENTS`, `ENABLE_ADMIN_ORDERS_DASHBOARD`, `ENABLE_GATEWAY_REFUND`.
- Guarantees proven: no oversell under concurrency; client price/paid-state ignored;
  idempotent settlement; signature-verified webhook; audited admin actions.
- Rollback: flags off → legacy behavior; or `git reset --hard <tag>`.

## 3. Production infrastructure requirements

| Area | Requirement |
|------|-------------|
| Runtime | Node 18+ LTS; process manager (PM2/systemd) or container (Docker) with auto-restart |
| Hosting | App host (Render/Railway/Fly/EC2/containers) with ≥2 instances behind a load balancer for zero-downtime deploys |
| TLS termination | At the LB/reverse proxy (Nginx/ALB/Cloud LB); HTTP→HTTPS redirect |
| Reverse proxy | Sets `X-Forwarded-*`; app already runs `app.set("trust proxy", 1)` |
| Static client | Served via CDN (Cloudflare/CloudFront) or the API; cache static assets, never cache `api.js` aggressively |
| Secrets | Vault/secret manager (no secrets in repo or images); injected as env at deploy |
| Config | One env set per environment: `staging` and `production` |
| Scaling | Stateless API (sessions in Mongo) → horizontal scale is safe; **note background jobs (sweeper/reconciliation) run per-instance — see Risks** |
| CI/CD | Build → automated checks → deploy to staging → promote to prod; immutable artifacts/tags |

## 4. Domain & SSL requirements

- Register/confirm production domain (e.g. `farmtokitchen.com`) + `www` and `api.`
  subdomain (or single-origin).
- **DNS:** A/AAAA or CNAME to the LB/host; CAA record; SPF/DKIM/DMARC for SES
  deliverability (see §7/§10).
- **TLS:** managed cert (ACM/Let's Encrypt/Cloudflare) with auto-renew; TLS 1.2+;
  HSTS already emitted by helmet (`max-age=31536000; includeSubDomains`).
- **Cookies:** require `NODE_ENV=production` so refresh/device cookies are `Secure;
  HttpOnly; SameSite=Lax`. If the client and API are on **different** origins,
  re-evaluate `SameSite=None; Secure` + exact `CLIENT_ORIGIN` (CORS already uses
  `credentials:true`).
- Set `APP_URL` and `CLIENT_ORIGIN` to the HTTPS production origins (used for emailed
  links + CORS).

## 5. MongoDB production requirements

- **Cluster:** dedicated Atlas tier (M10+), **replica set** (required for the Phase 3
  multi-document transactions), in the region nearest the app.
- **Access:** IP allow-list / VPC peering / PrivateLink; least-privilege DB user
  (no admin); separate users for app vs ops/backup.
- **Connection:** TLS, pooled; `MONGODB_URI` from the secret manager.
- **Indexes:** confirm all built (`node utils/migrateCommerce.js` + model
  `syncIndexes`) — includes the unique `stockledgers` idempotency index and the
  `orders.idempotencyKey` partial-unique index.
- **Data hygiene:** seed catalog (`npm run seed`), run `migrateUsers`/`migrateEmails`/
  `migrateCommerce`; verify no test/probe data; reset/confirm the `counters/order-YYYY`
  sequence so production order IDs start sensibly.
- **Performance:** enable Atlas Performance Advisor; set alerts on connections, replication lag, disk.

## 6. Backup & disaster recovery plan

- **Backups:** Atlas continuous/cloud backups with PITR enabled; retention ≥30 days.
  Keep the app-level `node utils/backupDb.js` as a pre-change snapshot tool.
- **RPO/RTO targets (proposed):** RPO ≤ 5 min (PITR), RTO ≤ 1 hour.
- **Restore drill:** documented + rehearsed restore to a scratch cluster quarterly;
  verify order/payment/inventory consistency post-restore.
- **DR:** multi-AZ Atlas; documented region-failover steps; infra-as-code so the app
  tier is reproducible.
- **Financial integrity:** `payments`, `paymentevents`, `stockledgers`,
  `commerceauditlogs` are the money/inventory ledgers — treat as
  write-once/retained; never purge without policy.
- **Rollback:** git tags (`pre-phase3` … `phase3-completion-report`) + flag-off for
  feature rollback; DB restore from PITR for data rollback.

## 7. Logging & monitoring plan

- **App logs:** structured JSON to stdout → shipped to a log platform
  (CloudWatch/Datadog/Logtail). Ensure **no secrets/PII/tokens/OTP/QR** are logged
  (already audited: TOTP secrets and codes are never logged).
- **Audit trails (already in product):** `AuthAuditLog` (security) and
  `CommerceAuditLog` (admin commerce actions) — surface in an ops view; set retention.
- **Metrics/APM:** request rate/latency/error rate; DB query latency; event-loop lag.
- **Health:** `GET /api/health` wired to the LB health check + uptime monitor.
- **Business/commerce alerts:** oversell-attempt (reservation conflict), payment
  amount/currency mismatch (`PaymentEvent type:"mismatch"`), webhook signature
  failures, refund volume, manual-release frequency, reconciliation settlements.
- **Security alerts:** spike in `admin_login_failed`, `admin_mfa_challenge_failed`,
  rate-limit 429s, new-device logins.
- **On-call:** paging policy + runbooks (`PHASE3_ACTIVATION_RUNBOOK.md`,
  `OPERATIONS_RECOVERY.md`).

## 8. Environment variable audit

**Core (required):** `NODE_ENV=production`, `PORT`, `MONGODB_URI`, `JWT_SECRET`
(long random), `CLIENT_ORIGIN`, `APP_URL`, `PAYSTACK_SECRET_KEY`,
`SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` (**rotate before launch**).

**Security/identity:** `MFA_ENC_KEY` (≥32B, vaulted — losing it forces admin
re-enroll), `MFA_ISSUER`, `ADMIN_ACCESS_TTL`, `ACCESS_TTL`, `REFRESH_TTL_DAYS`,
`MAX_FAILED_LOGINS`, `LOGIN_LOCK_MS`, `ADMIN_MFA_MAX_ATTEMPTS`, `ADMIN_MFA_LOCK_MS`,
`ADMIN_ENROLL_TTL`, `ADMIN_CHALLENGE_TTL`, `AUTH_RATE_MAX`, `AUTH_RATE_WINDOW_MS`,
`API_RATE_MAX`, `PASSWORD_MIN_LEN`, `PASSWORD_HISTORY`, `HIBP_ENABLED`,
`HIBP_FAIL_OPEN`.

**Providers:** `AWS_REGION`, `SES_FROM` (verified identity); `TWILIO_ACCOUNT_SID`,
`TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID`, `TWILIO_LOOKUP_ENABLED`; email/phone
tunables (`EMAIL_*`, `PHONE_*`, `RESET_*`).

**Feature flags — intended production values:**
| Flag | Launch value |
|------|--------------|
| `ENABLE_RATE_LIMIT`, `ENABLE_AUDIT`, `ENABLE_LOCKOUT`, `ENABLE_REFRESH_TOKENS`, `ENABLE_DEVICE_TRACKING` | ON |
| `ENABLE_EMAIL`, `ENABLE_EMAIL_VERIFICATION`, `ENABLE_PHONE_VERIFICATION`, `ENABLE_PASSWORD_RESET` | ON (after providers wired) |
| `ENABLE_ADMIN_MFA` | ON (after admin enrolls) |
| `ENABLE_LOGIN_ALERTS`, `ENABLE_SESSION_UI` | ON (optional) |
| `ENABLE_COMMERCE_INTEGRITY`, `ENABLE_PAYMENT_WEBHOOK`, `ENABLE_ADMIN_ORDERS_DASHBOARD` | ON (staged — see §9) |
| `ENABLE_GATEWAY_REFUND` | ON last (after refund-policy reconciliation) |
| `ALLOW_SIMULATED_PAYMENTS`, `EMAIL_DEV_ECHO`, `PHONE_DEV_ECHO`, `PWRESET_DEV_ECHO`, `PHONE_DEV_VOIP` | **OFF (must)** |

**Action:** produce a signed-off `production.env` in the secret manager; diff against
this audit; assert all dev-echo/simulation flags are off.

## 9. Checkout activation sequence

Per `PHASE3_ACTIVATION_RUNBOOK.md`, staged with verification gates:
1. Pre-flight: replica set, real Paystack key, `ALLOW_SIMULATED_PAYMENTS` OFF, DB
   backup, `node utils/migrateCommerce.js`.
2. `ENABLE_COMMERCE_INTEGRITY=true` → verify boot jobs + a staging order reserves
   and re-prices.
3. `ENABLE_PAYMENT_WEBHOOK=true` → register webhook URL; verify 401/200 signature +
   settlement.
4. `ENABLE_ADMIN_ORDERS_DASHBOARD=true` → verify 401/403/200 + an admin action +
   audit row.
5. `ENABLE_GATEWAY_REFUND=true` (last) → verify a staging refund hits Paystack.
6. Identity activation (parallel track): `ENABLE_ADMIN_MFA` (admin enrolls, store
   recovery codes), email/phone verification, password reset.
Each step independently reversible by unsetting its flag.

## 10. Payment gateway activation checklist

- [ ] Paystack **live** account approved (KYC/settlement bank set).
- [ ] Live `PAYSTACK_SECRET_KEY` (server, vaulted) + live public key (client checkout).
- [ ] `ALLOW_SIMULATED_PAYMENTS` **OFF** in prod.
- [ ] Webhook URL `https://<host>/api/payments/webhook` registered; signature secret =
      `PAYSTACK_SECRET_KEY` (HMAC-SHA512 over raw body) — verified 401 on bad sig.
- [ ] Client sends `metadata.orderId` (already implemented in `checkout.html`).
- [ ] Currency = NGN confirmed end-to-end (amounts in kobo); refunds policy defined.
- [ ] Reconciliation job verified (settles open orders carrying a reference).
- [ ] End-to-end live test: small real charge → order Paid + committed + receipt;
      then a real refund (if `ENABLE_GATEWAY_REFUND`).

## 11. Mobile readiness checklist

- [ ] Responsive audit of `index/checkout/account/admin` at 320–768px; tap targets ≥44px.
- [ ] Mobile checkout: Paystack inline renders + returns on iOS Safari / Android Chrome.
- [ ] Forms use correct input types/`autocomplete`; OTP fields mobile-friendly.
- [ ] Viewport meta + no horizontal scroll; images responsive/lazy-loaded.
- [ ] PWA basics (optional): manifest, icons, offline catalog cache.
- [ ] Performance on 3G/4G: Lighthouse mobile ≥ acceptable; minimize base64 image payloads.
- [ ] Cross-device session/device-alert flows behave (Phase 2.6) if enabled.

## 12. Launch readiness checklist

- [ ] `NODE_ENV=production`; Secure cookies confirmed via `Set-Cookie` inspection.
- [ ] Seeded admin password rotated; `ENABLE_ADMIN_MFA` on and admin enrolled (codes stored).
- [ ] All dev-echo/simulation flags OFF (env diff signed off).
- [ ] HTTPS + HSTS + valid cert; `CLIENT_ORIGIN`/`APP_URL` set to prod.
- [ ] Atlas prod cluster (replica set), backups/PITR on, indexes built, no probe data.
- [ ] SES domain verified (SPF/DKIM/DMARC); Twilio Verify live; HIBP on.
- [ ] Phase 3 flags activated + verified per §9; webhook live (§10).
- [ ] Monitoring/alerting/health-check live; on-call + runbooks in place.
- [ ] Load/smoke test on staging (incl. concurrency/no-oversell, checkout, refund).
- [ ] Legal/ops: privacy policy, terms, refund policy, support contact, order emails.
- [ ] Rollback rehearsed (flag-off + git tag + PITR).
- [ ] Go/No-Go sign-off (eng, ops, finance).

## 13. Risks & mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Launching with dev cookies (`NODE_ENV` ≠ production) | Session theft | Hard gate in launch checklist; verify `Set-Cookie` |
| Background jobs run **per-instance** (multi-instance deploy) | Duplicate sweeper/reconciliation work | Idempotent by design (ledger unique + state guards); for scale, pin jobs to one instance or add a lock/scheduler |
| `MFA_ENC_KEY` / `JWT_SECRET` loss or rotation | Admin lockout / global logout | Vault + backup the keys; documented re-enroll (ops CLI) |
| Paystack misconfig / `ALLOW_SIMULATED_PAYMENTS` left on | Forged payments | Checklist asserts off; webhook signature mandatory; amount verified server-side |
| Webhook not registered / missed | Orders stuck Awaiting Payment | Reconciliation job + confirm endpoint as fallbacks |
| Atlas not a replica set | Transactions fail → integrity path errors | Pre-flight assertion before enabling `ENABLE_COMMERCE_INTEGRITY` |
| Email deliverability (SPF/DKIM) | Verification/reset emails to spam | Domain auth + monitored bounce/complaint rates |
| Order-ID counter offset from testing | Cosmetic ID gap | Reset `counters/order-YYYY` pre-launch |
| No automated CI suite | Regressions slip | Add CI smoke/integration tests as a fast-follow |
| PII at rest (orders, addresses, phones) | Compliance | Access controls, retention policy, encryption-at-rest (Atlas) |

## 14. Estimated timeline to production launch

Assumes one engineer + ops support; staging available. Calendar estimate.

| Workstream | Effort |
|------------|--------|
| Infra: hosting, LB, TLS, secrets, CI/CD, CDN | 3–5 days |
| Domain/DNS/email auth (SPF/DKIM/DMARC) + propagation | 1–2 days (+ provider lead time) |
| Atlas prod cluster, network, backups/PITR, indexes, data hygiene | 1–2 days |
| Provider go-live: Paystack live + KYC, SES prod, Twilio live | 2–4 days (+ Paystack KYC lead time, can run in parallel) |
| Logging/monitoring/alerting + on-call | 2–3 days |
| Staged flag activation + staging E2E (identity + checkout + refund) | 2–3 days |
| Mobile/responsive + load/security testing | 2–4 days |
| Buffer + Go/No-Go + launch | 1–2 days |

**Net ~2–3 weeks** to a controlled production launch, gated chiefly by external lead
times (Paystack live approval, domain/email verification) rather than engineering.
A soft-launch (limited traffic) can begin as soon as §10 live-payment E2E and §12
core gates pass.

---

_No application code changed. No Phase 3 flags enabled. This is a planning document
only; execution is gated on your approval._
