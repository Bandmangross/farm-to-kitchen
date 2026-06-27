# Phase 4 — Workstreams & Execution Roadmap

_Owner: Platform Engineering · Status: **PLAN (no code)** · 2026-06-25_
_Operational breakdown of `PHASE4_EXECUTION_CHECKLIST.md` into ownership, effort, risk,
required evidence, and gates, plus a Day‑1→launch roadmap. Documentation only — no
application code, no Phase 5 activation, all flags remain OFF._

**Owner key:** PE = Platform Eng · BE = Backend Eng · DevOps · SecEng · QA · FE =
Frontend · Ops · Finance. **Risk:** 🔴 High · 🟠 Med · 🟢 Low. **Effort:** engineer-days
(excludes external provider lead time, called out separately).

---

## 1. Email Infrastructure

| Field | Detail |
|---|---|
| **Owner** | BE + DevOps (SecEng review) |
| **Dependencies** | Sending domain + DNS (WS2); AWS account; **SES production access (out of sandbox)** |
| **Estimated effort** | 1.5–2 d eng · + **2–5 d external** (SES prod approval, DNS propagation) |
| **Risk** | 🔴 High — pipeline currently inert; real users stuck `pending_verification` |
| **Verification evidence** | Boot log `[Email] AWS SES transport ready` (no `[Email:DEV]`); `verificationcodes` doc created on register; `AuthAuditLog event=email_sent`; real inbox delivery (not spam); reset email delivered; dev-echo flags OFF |
| **Go/No-Go gate** | GO when verification + reset emails land in inbox with DB token + audit and SES out of sandbox; NO-GO on any `reason:"dev"`, spam placement, or sandbox |

## 2. Domain & SSL

| Field | Detail |
|---|---|
| **Owner** | DevOps (PE review) |
| **Dependencies** | Registered domain; DNS access; TLS-terminating LB/host; SES identity (WS1) |
| **Estimated effort** | 1 d eng · + **0.5–2 d external** (DNS/cert propagation) |
| **Risk** | 🟠 Med — misconfig silently breaks auth cookies / CORS / email auth |
| **Verification evidence** | `https://<domain>/api/health` 200; valid cert + HSTS header; `Set-Cookie ftk_refresh` = `HttpOnly; Secure; SameSite=Lax`; SPF/DKIM/DMARC pass; credentialed CORS works |
| **Go/No-Go gate** | GO when HTTPS valid, Secure cookies confirmed, email-auth passes; NO-GO on invalid cert, non-Secure cookies, DMARC fail |

## 3. MongoDB Production Setup

| Field | Detail |
|---|---|
| **Owner** | DevOps + BE |
| **Dependencies** | Atlas org/project; network plan (allow-list/PrivateLink); secret manager |
| **Estimated effort** | 1–2 d eng |
| **Risk** | 🔴 High — standalone (no transactions) breaks commerce integrity; open network = data exposure |
| **Verification evidence** | Replica-set reachable only from app egress; live indexes (`stockledgers` unique idempotency, `orders.idempotencyKey` partial-unique, `paymentevents`, `commerceauditlogs`); `migrateCommerce.js` idempotent (0 updates 2nd run); no probe data; `counters/order-YYYY` reset |
| **Go/No-Go gate** | GO when replica set + indexes + clean data + locked network; NO-GO on standalone, open `0.0.0.0/0`, missing unique indexes, residual test data |

## 4. Paystack Production Setup

| Field | Detail |
|---|---|
| **Owner** | BE + Finance (DevOps for webhook) |
| **Dependencies** | **Approved Paystack live account (KYC + settlement bank)**; WS2 (HTTPS webhook); WS3 (transactions) |
| **Estimated effort** | 1–2 d eng · + **2–5 d external** (KYC/live approval) |
| **Risk** | 🔴 High — revenue path; forged/duplicate payments if misconfigured |
| **Verification evidence** | Live keys vaulted; `ALLOW_SIMULATED_PAYMENTS` OFF; webhook bad-sig→401 / valid→200 + settle; `metadata.orderId` sent; real live charge → Paid + committed + receipt (kobo matches); reconciliation settles a missed confirm |
| **Go/No-Go gate** | GO when live charge settles correctly with signed webhook and simulation off; NO-GO on placeholder key, simulation on, unverified webhook, amount mismatch |

## 5. Monitoring & Alerting

| Field | Detail |
|---|---|
| **Owner** | DevOps + SecEng |
| **Dependencies** | Log/APM platform; `/api/health`; audit trails + `PaymentEvent`/`StockLedger` |
| **Estimated effort** | 2–3 d eng |
| **Risk** | 🟠 Med — blind to outages/fraud/oversell without it |
| **Verification evidence** | Dashboards live; health check wired to LB + uptime; commerce alerts (`PaymentEvent mismatch`, webhook sig fail, oversell, refunds) and security alerts (`admin_login_failed`, MFA fails, 429s) fire on a synthetic test; logs verified PII/secret-clean |
| **Go/No-Go gate** | GO when critical alerts page on-call and logs are clean; NO-GO on no error/latency visibility, no payment/security alerts, secrets in logs |

## 6. Backup & Disaster Recovery

| Field | Detail |
|---|---|
| **Owner** | DevOps (BE for data validation) |
| **Dependencies** | WS3 (Atlas); secret/key custody (`JWT_SECRET`, `MFA_ENC_KEY`) |
| **Estimated effort** | 2–3 d eng (incl. restore drill) |
| **Risk** | 🔴 High — ledgers are financial records; untested backups = no backups |
| **Verification evidence** | PITR on (RPO ≤5 m / RTO ≤1 h); **restore drill passed** to scratch cluster with consistent order/payment/inventory ledgers; secrets backed up independently; rollback rehearsed (flag-off + git tag + PITR); ledger retention policy set |
| **Go/No-Go gate** | GO when a restore drill succeeds with consistent ledgers and rollback is proven; NO-GO on unverified backups, no successful drill, secrets only in env/DB |

## 7. Mobile Readiness Audit

| Field | Detail |
|---|---|
| **Owner** | FE + QA |
| **Dependencies** | WS2 (HTTPS for Paystack inline); WS4 (live payment for E2E) |
| **Estimated effort** | 2–4 d eng |
| **Risk** | 🟠 Med — majority mobile traffic; broken checkout loses revenue |
| **Verification evidence** | Responsive 320–768px (no h-scroll, ≥44px targets); mobile Paystack inline charge completes on iOS Safari + Android Chrome; correct input types/autocomplete; Lighthouse mobile within target; flows pass on 3G/4G throttle |
| **Go/No-Go gate** | GO when a real mobile charge completes on iOS + Android with acceptable Lighthouse; NO-GO on checkout failure on a major mobile browser or broken layout |

## 8. Launch Gate Review

| Field | Detail |
|---|---|
| **Owner** | PE (sign-off: Eng + Ops + Finance) |
| **Dependencies** | WS1–WS7 all at **GO** |
| **Estimated effort** | 1–2 d |
| **Risk** | 🔴 High — final guard against silent blockers |
| **Verification evidence** | Each WS1–7 GO recorded with evidence; `NODE_ENV=production` + Secure cookies; **all dev-echo + `ALLOW_SIMULATED_PAYMENTS` OFF** (signed env diff); admin password rotated + MFA enrolled; staging load/no-oversell test passed; legal/ops live; rollback rehearsed |
| **Go/No-Go gate** | GO on all sub-gates green + sign-offs + proven rollback → open traffic (soft-launch first); NO-GO on any §1–7 NO-GO, any dev/simulation flag on, or unproven rollback |

---

## Cross-cutting

| Item | Owner | Risk | Note |
|---|---|---|---|
| Identity activation (`ENABLE_ADMIN_MFA`, email/phone verify, password reset, optional session UI/login alerts) | BE + SecEng | 🟠 | Parallel to commerce; depends on WS1 (email) |
| Background jobs run **per-instance** at scale | BE + DevOps | 🟠 | Idempotent by design; pin to one instance or add a lock for multi-instance |
| Secret/key rotation policy (`JWT_SECRET`, `MFA_ENC_KEY`, Paystack) | SecEng | 🟠 | Rotation = forced re-auth / admin re-enroll; document blast radius |
| CI smoke/integration suite | QA + BE | 🟢 | Fast-follow; not a launch blocker but reduces regression risk |

---

## Execution roadmap (Day 1 → launch readiness)

Calendar assumes one PE/BE + DevOps + part-time SecEng/QA, staging available. External
lead times (SES prod, domain/cert, Paystack KYC) **start Day 1** and run in background.

| Day(s) | Workstreams in flight | Exit criteria |
|---|---|---|
| **D1** | Kick off external: SES production request, domain/DNS, Paystack KYC. Start WS3 (Atlas provision). | Provider requests submitted; cluster provisioning started |
| **D2–D3** | WS3 finish (indexes, data hygiene, network); WS2 DNS/cert + email-auth records published | Replica set GO-ready; HTTPS health 200; SPF/DKIM/DMARC published |
| **D3–D5** | WS1 Email (once SES approved) ∥ WS5 Monitoring scaffolding | Verification + reset emails inbox-delivered; dashboards/health live |
| **D5–D7** | WS4 Paystack (once live approved): keys, staged flag activation, webhook, live charge | Live charge settles; signed webhook verified; simulation off |
| **D6–D8** | WS6 Backup/DR restore drill ∥ Identity activation (MFA, verify, reset) | Restore drill passed; admin MFA enrolled |
| **D7–D10** | WS7 Mobile audit + staging load/no-oversell test ∥ WS5 alert tuning | Mobile E2E charge passes; load/concurrency clean; alerts page on-call |
| **D10–D12** | WS8 Launch Gate Review: env diff, sign-offs, rollback rehearsal | All gates GO; Eng/Ops/Finance sign-off |
| **D12+** | **Soft-launch** (limited traffic) → monitor → ramp to full launch | Stable under real traffic; no critical alerts |

**Net ~2–2.5 weeks** to launch-ready, gated primarily by external approvals (SES prod,
Paystack KYC, domain/cert) rather than engineering effort. Critical path:
WS3 → WS4 → WS6/WS8. WS1 and WS2 are early because most downstream items depend on them.

---

_No application code changed. No Phase 5 activation. All Phase 3 and production flags
remain OFF. This document plans execution only; each activation is gated on its
workstream's Go/No-Go evidence._
