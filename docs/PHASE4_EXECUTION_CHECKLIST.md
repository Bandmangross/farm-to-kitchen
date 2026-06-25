# Phase 4 — Execution Checklist

_Owner: Platform Engineering · Status: **CHECKLIST (no code)** · 2026-06-25_
_Execution detail for `PHASE4_PRODUCTION_READINESS_PLAN.md`. Each item has a single
objective, why it matters, dependencies, verification steps, and an explicit
Go/No-Go gate. No application code changes; Phase 3 and production flags remain
unchanged until each item's gate passes._

**Recommended order:** 2 (Domain/SSL) → 3 (Mongo) → 1 (Email) ∥ 4 (Paystack) →
5 (Monitoring) → 6 (Backup/DR) → 7 (Mobile) → 8 (Launch Gate). Items 1 and 4 can run
in parallel (both have external lead times).

---

## 1. Email Infrastructure

**Objective.** Make transactional email (verification, password reset, password
changed, new-device alert) actually deliver to real inboxes via AWS SES.

**Why it matters.** The pipeline is currently **inert** — investigation found
`ENABLE_EMAIL_VERIFICATION` off and no SES credentials, so the email job is never
invoked and the transport is the DEV console logger. Real users (e.g.
`abiodunolamideay@gmail.com`) are stuck `pending_verification`. Without working email
there is no account verification, password recovery, or security alerting.

**Dependencies.** Verified sending domain; DNS access (SPF/DKIM/DMARC — overlaps §2);
AWS account + SES production access (out of sandbox); secret manager.

**Verification steps.**
1. Set `AWS_REGION`, `SES_FROM` (a verified identity), IAM send permission; set
   `ENABLE_EMAIL` (real send), `ENABLE_EMAIL_VERIFICATION=true`, `ENABLE_PASSWORD_RESET=true`.
2. Restart; confirm boot/first-send log shows `[Email] AWS SES transport ready (region …)` (not `[Email:DEV]`).
3. Register a real test address → confirm a `verificationcodes` doc (`purpose=email_verify`) is created and an `AuthAuditLog event=email_sent` is written.
4. Confirm the email arrives in the inbox (not spam); complete verification → `emailVerified=true`, `accountStatus=active`.
5. Trigger a password reset → confirm delivery + `password_reset` audit.
6. Confirm dev-echo flags OFF: `EMAIL_DEV_ECHO`, `PWRESET_DEV_ECHO` unset.

**Go/No-Go.**
- **GO:** SES transport active; verification + reset emails land in inbox; DB token + audit present; dev-echo off.
- **NO-GO:** any `[Email:DEV]`/`reason:"dev"` in logs; mail in spam; SES still in sandbox; no `email_sent` audit.

---

## 2. Domain & SSL

**Objective.** Serve the platform on the production domain over HTTPS with valid
certificates, correct DNS, and email-auth records.

**Why it matters.** Secure cookies, HSTS, CORS with credentials, emailed links
(`APP_URL`), and SES deliverability all depend on a correctly configured domain +
TLS. Mis-set `CLIENT_ORIGIN`/`SameSite` silently breaks auth.

**Dependencies.** Registered domain; DNS provider access; LB/host that terminates TLS;
SES domain identity (§1).

**Verification steps.**
1. DNS A/AAAA/CNAME for apex + `www` (+ `api.` if split origin); CAA record set.
2. Email auth: SPF, DKIM (SES), DMARC published; validate with a mail-auth checker.
3. Managed cert issued (TLS 1.2+); HTTP→HTTPS redirect; `https://<domain>/api/health` → 200.
4. Set `NODE_ENV=production`, `APP_URL`, `CLIENT_ORIGIN` to the HTTPS origins; restart.
5. Inspect `Set-Cookie` on login: `ftk_refresh` is `HttpOnly; Secure; SameSite=Lax`; HSTS header present.
6. If client/API are cross-origin, confirm CORS preflight + credentialed requests succeed.

**Go/No-Go.**
- **GO:** HTTPS valid; HSTS on; Secure cookies confirmed; SPF/DKIM/DMARC pass; health 200 over TLS.
- **NO-GO:** cert invalid/expiring; cookies not `Secure`; DMARC fail; CORS blocks credentialed calls.

---

## 3. MongoDB Production Setup

**Objective.** Provision a dedicated, secured, backed-up Atlas **replica set** with all
indexes and clean data.

**Why it matters.** Phase 3 commerce integrity uses multi-document **transactions**,
which require a replica set; the unique idempotency indexes prevent double-charge /
oversell. Network exposure or a missing index is a money/inventory risk.

**Dependencies.** Atlas org/project; network plan (IP allow-list / PrivateLink);
secret manager for `MONGODB_URI`.

**Verification steps.**
1. Cluster M10+ (replica set) in the app region; TLS; least-privilege app user.
2. Network locked to app egress (no `0.0.0.0/0`).
3. `node utils/migrateCommerce.js` (idempotent) + model `syncIndexes`; verify live indexes:
   `stockledgers` unique `orderId+type+product+variantLabel`, `orders.idempotencyKey` partial-unique, `paymentevents`, `commerceauditlogs`.
4. Seed catalog; run `migrateUsers`/`migrateEmails`/`migrateCommerce`; confirm **no probe/test data**.
5. Reset/confirm `counters/order-YYYY` so the first production order ID is sensible.
6. Enable Performance Advisor + alerts (connections, replication lag, disk).

**Go/No-Go.**
- **GO:** replica set reachable only from app; all indexes present; clean data; sequence reset; backups on (see §6).
- **NO-GO:** standalone (no transactions); open network; missing unique indexes; residual test data.

---

## 4. Paystack Production Setup

**Objective.** Activate live payments with server-side verification and a
signature-verified webhook.

**Why it matters.** Payments are the revenue path. Server-side verify + kobo/currency
checks + idempotency + signed webhook are what prevent forged or duplicate payments;
a missing webhook leaves orders stuck Awaiting Payment.

**Dependencies.** Approved Paystack live account (KYC + settlement bank); §2 (HTTPS
webhook URL); §3 (transactions for commit).

**Verification steps.**
1. Live `PAYSTACK_SECRET_KEY` (server, vaulted) + live public key (client); `ALLOW_SIMULATED_PAYMENTS` **OFF**.
2. Enable `ENABLE_COMMERCE_INTEGRITY`, `ENABLE_PAYMENT_WEBHOOK` (staged per `PHASE3_ACTIVATION_RUNBOOK.md`).
3. Register webhook `https://<host>/api/payments/webhook`; confirm bad signature → 401, valid `charge.success` → 200 + order settles.
4. Confirm client sends `metadata.orderId` (checkout.html) so the webhook correlates.
5. Real small live charge → order `Paid` + stock committed + receipt; verify amount in kobo matches server total.
6. Reconciliation job verified; (optional) `ENABLE_GATEWAY_REFUND` last, with a real staging refund.

**Go/No-Go.**
- **GO:** live keys set; simulation off; webhook signature enforced; live charge settles correctly; reconciliation works.
- **NO-GO:** placeholder/`xxxx` key; `ALLOW_SIMULATED_PAYMENTS` on; webhook unverified/unregistered; amount mismatch.

---

## 5. Monitoring & Alerting

**Objective.** Full visibility into health, errors, security, and commerce — with
paging on the events that matter.

**Why it matters.** A live store needs to detect outages, fraud, oversell, payment
mismatches, and deliverability failures before customers (or finance) do.

**Dependencies.** Log/APM platform; `GET /api/health`; the two audit trails
(`AuthAuditLog`, `CommerceAuditLog`) and `PaymentEvent`/`StockLedger`.

**Verification steps.**
1. Ship structured app logs; confirm **no secrets/PII/tokens/OTP** in logs (spot-check).
2. LB/uptime monitor on `/api/health`; APM for latency/error rate/event-loop lag.
3. Commerce alerts: `PaymentEvent type:"mismatch"`, webhook signature failures, oversell/reservation conflicts, refund volume, manual-release frequency.
4. Security alerts: spikes in `admin_login_failed`, `admin_mfa_challenge_failed`, 429 rate-limits, new-device logins.
5. Email alerts: SES bounce/complaint rate; `email_sent` vs verification-completion ratio.
6. On-call rotation + runbooks linked (`OPERATIONS_RECOVERY.md`, `PHASE3_ACTIVATION_RUNBOOK.md`); fire a synthetic alert end-to-end.

**Go/No-Go.**
- **GO:** dashboards live; health check wired; critical alerts page on-call; synthetic alert delivered; logs PII-clean.
- **NO-GO:** no error/latency visibility; no payment/security alerts; secrets found in logs; no on-call.

---

## 6. Backup & Disaster Recovery

**Objective.** Guaranteed, tested recovery of all data — especially the money/inventory
ledgers — within agreed RPO/RTO.

**Why it matters.** Orders, payments, and stock ledgers are financial records; data
loss or an unrecoverable corruption is existential. Untested backups are not backups.

**Dependencies.** §3 (Atlas); backup tooling (`node utils/backupDb.js` for pre-change
snapshots); secret/key custody (`JWT_SECRET`, `MFA_ENC_KEY`).

**Verification steps.**
1. Atlas continuous backup + PITR enabled; retention ≥30 days; targets RPO ≤5 min, RTO ≤1 h.
2. Rehearse a restore to a scratch cluster; validate order/payment/inventory/ledger consistency post-restore.
3. Document + rehearse region failover; infra reproducible from code.
4. Back up secrets/keys independently of the DB (losing `MFA_ENC_KEY` forces admin MFA re-enroll; rotating `JWT_SECRET` logs everyone out).
5. Confirm rollback paths: feature flag-off; git tags (`pre-phase3`…`phase3-completion-report`); DB PITR.
6. Define retention/no-purge policy for `payments`, `paymentevents`, `stockledgers`, `commerceauditlogs`.

**Go/No-Go.**
- **GO:** PITR on; restore drill **passed** with consistent ledgers; secrets backed up; rollback rehearsed; retention set.
- **NO-GO:** backups unverified; no successful restore drill; secrets only in DB/env; no documented RTO/RPO.

---

## 7. Mobile Readiness Audit

**Objective.** Confirm the storefront, checkout, account, and admin work and convert on
mobile devices.

**Why it matters.** The majority of ecommerce traffic is mobile; a broken mobile
checkout or unreadable form directly loses revenue.

**Dependencies.** §2 (HTTPS — required for Paystack inline + service workers); §4 (live
payment for end-to-end mobile checkout test).

**Verification steps.**
1. Responsive audit `index/checkout/account/admin` at 320–768px; no horizontal scroll; tap targets ≥44px.
2. Mobile checkout: Paystack inline opens, charges, and returns on iOS Safari + Android Chrome.
3. Inputs use correct types/`autocomplete`; OTP/verification fields are mobile-friendly.
4. Viewport meta present; images responsive/lazy; trim base64 payloads; Lighthouse mobile within target.
5. Verify on 3G/4G throttling; key flows complete under latency.
6. (If enabled) Phase 2.6 device/session + login-alert flows behave across devices.

**Go/No-Go.**
- **GO:** mobile checkout completes a real charge on iOS + Android; no layout breakage; acceptable Lighthouse mobile.
- **NO-GO:** checkout fails/inline blocked on a major mobile browser; broken layout; failing core web vitals.

---

## 8. Launch Gate Review

**Objective.** Single, final Go/No-Go combining all gates before opening to public
traffic.

**Why it matters.** Prevents launching with a silent blocker (dev cookies, sandbox
SES, simulation payments, unverified backups). One checklist, signed off by eng + ops
+ finance.

**Dependencies.** Items 1–7 each at **GO**.

**Verification steps.**
1. Confirm each section (1–7) recorded **GO** with evidence.
2. `NODE_ENV=production`; Secure cookies verified; **all dev-echo + `ALLOW_SIMULATED_PAYMENTS` OFF** (env diff signed).
3. Seeded admin password rotated; `ENABLE_ADMIN_MFA` on and admin enrolled (recovery codes stored).
4. Intended production flag set applied + verified; Phase 3 checkout activated per runbook.
5. Staging load/smoke test passed (concurrency/no-oversell, checkout, refund, auth).
6. Legal/ops live: privacy, terms, refund policy, support contact, order emails.
7. Rollback rehearsed (flag-off + git tag + PITR); on-call active.
8. Go/No-Go meeting: eng + ops + finance sign-off recorded.

**Go/No-Go.**
- **GO:** all sub-gates green; sign-offs captured; rollback proven; monitoring live → open traffic (consider soft-launch first).
- **NO-GO:** any §1–7 at NO-GO; any dev/simulation flag on; rollback unproven; missing sign-off.

---

_No application code changed. Phase 3 and production flags unchanged. This checklist
governs execution; each gate must pass before its dependent activation proceeds._
