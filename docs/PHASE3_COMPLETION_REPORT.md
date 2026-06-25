# Phase 3 — Completion Report

_Commerce Integrity & Checkout Hardening + Admin Orders Dashboard._
_Status: **IMPLEMENTED, VERIFIED, DORMANT (flags OFF)** · 2026-06-25_

| | |
|---|---|
| Implementation commit | `9139b75` — tag `phase3-verified` |
| Docs/runbook commit | `70d367c` — tag `phase3-runbook` |
| Rollback baseline | `3a93f6b` — tag `pre-phase3` |
| Branch HEAD | `master` |
| Resting state | all Phase 3 flags **OFF**; backend healthy on :5050 |

---

## 1. Objectives completed

| # | Objective | Status |
|---|-----------|--------|
| 1 | Server-authoritative pricing (client price/total/paid-state ignored) | ✅ |
| 2 | Reserve-on-create + commit-on-payment inventory (`available = stock − reserved`) | ✅ |
| 3 | No-oversell guarantee under concurrency (atomic, transactional) | ✅ |
| 4 | Mandatory, idempotent payment verification (kobo + currency vs server total) | ✅ |
| 5 | Signature-verified Paystack webhook + reconciliation/sweeper jobs | ✅ |
| 6 | Single order state machine (illegal transitions rejected) | ✅ |
| 7 | Atomic, gap-free order IDs (fixes R8 race) | ✅ |
| 8 | Fixed R7 variant-quantity under-deduction | ✅ |
| 9 | Admin Orders Dashboard: list/filter/search, payment & inventory views, cancel/refund/release | ✅ |
| 10 | Dedicated `CommerceAuditLog` for every admin action (reason required) | ✅ |
| 11 | Everything behind default-off flags; legacy behavior preserved when off | ✅ |

Out of scope / untouched: identity, Phase 2.5 admin MFA, storefront catalog UI.

## 2. Files changed (commit `9139b75`: 26 files, +1258 / −12)

**New — server (12):** `controllers/adminOrdersController.js`, `routes/admin.js`,
`models/{Counter,StockLedger,PaymentEvent,CommerceAuditLog}.js`,
`utils/{paystack,orderState,commerceAudit,migrateCommerce}.js`,
`jobs/{reservationSweeper,paymentReconciliation}.js`.

**Modified — server (6):** `controllers/{orderController,paymentController}.js`,
`models/{Order,Product}.js`, `utils/inventory.js`, `server.js`.

**Modified — client (3):** `api.js` (`API.adminOrders.*`), `admin.html` (orders
dashboard panel), `checkout.html` (+`metadata.orderId`).

**Docs (5 + runbook):** `ARCHITECTURE.md`, `DEPLOYMENT_CHECKLIST.md`,
`OPERATIONS_RECOVERY.md`, `PHASE_3_DESIGN.md`, `README.md`,
`PHASE3_ACTIVATION_RUNBOOK.md`.

**No new dependencies.**

## 3. Database collections & indexes (additive; live from Atlas)

New collections: `counters`, `stockledgers`, `paymentevents`, `commerceauditlogs`.
Existing `orders` / `products` extended in place.

```
counters          : _id_
stockledgers      : _id_
                    orderId_1_type_1_product_1_variantLabel_1  UNIQUE  partial={orderId:{$gt:""}}
                    product_1_createdAt_-1
paymentevents     : _id_
                    orderId_1_createdAt_-1
                    reference_1_createdAt_-1
commerceauditlogs : _id_
                    orderId_1_createdAt_-1
                    admin_1_createdAt_-1
orders            : + idempotencyKey_1  UNIQUE  partial={idempotencyKey:{$type:"string"}}
```

Schema additions (additive, inert when flags off):
- **Order:** `currency`, `serverTotal`, `serverGrandTotal`, `idempotencyKey`, `version`, `inventoryState` (`none|reserved|committed|released`), `reservationExpiresAt`, `statusHistory[]`; per-line `qty`/`unitPrice`/`lineTotal`; status enum +`Refunded`.
- **Product / variant:** `reserved`.

Backfill: `node utils/migrateCommerce.js` — additive, **idempotent** (2nd run reports 0 updates), also creates the collections/indexes.

## 4. Environment flags (read from code — all default OFF)

| Flag | Effect when `=true` | Source |
|------|---------------------|--------|
| `ENABLE_COMMERCE_INTEGRITY` | hardened create/confirm/status + jobs + ensureCollections at boot | orderController.js:8, paymentController.js:9, server.js:53 |
| `ENABLE_PAYMENT_WEBHOOK` | `POST /api/payments/webhook` active (else 404) | paymentController.js:171 |
| `ALLOW_SIMULATED_PAYMENTS` | enables `SIMULATED-` branch in confirm — **dev only** | paystack.js:53 |
| `ENABLE_ADMIN_ORDERS_DASHBOARD` | `/api/admin/*` active (else 404) | routes/admin.js:12 |
| `ENABLE_GATEWAY_REFUND` | admin refund also calls Paystack `/refund` | adminOrdersController.js:125 |

Tunables (defaults): `RESERVATION_TTL_MIN=30`, `DEFAULT_DELIVERY_FEE=3000`,
`RESERVATION_SWEEP_INTERVAL_MS=60000`, `RECONCILE_INTERVAL_MS=300000`.

## 5. Routes

**Behavior switch (same paths, hardened impl when `ENABLE_COMMERCE_INTEGRITY=true`):**
`POST /api/orders` → createSecure · `POST /api/payments` → confirmSecure ·
`PUT /api/orders/:id/status` → updateStatusSecure.

**Reachable only when flag enabled (else 404):**
- `ENABLE_PAYMENT_WEBHOOK` → `POST /api/payments/webhook`
- `ENABLE_ADMIN_ORDERS_DASHBOARD` → behind `apiLimiter → dashboardOn → protect → admin`:
  - `GET /api/admin/orders`, `/orders/:id`, `/orders/:id/payments`, `/orders/:id/inventory`, `/payments`, `/inventory`
  - `POST /api/admin/orders/:id/cancel`, `/orders/:id/refund`, `/orders/:id/release`

## 6. Verification evidence

Per-milestone live tests against the Atlas replica set:

| Milestone | Scope | Result |
|-----------|-------|--------|
| M1 | models load, idempotent migration | pass |
| M2 | reserve/commit/release/refund, **no-oversell concurrency**, R7 fix, ledger | 9/9 |
| M3 | server re-pricing (price-tamper ignored), paid-spoof ignored, reserve, mandatory verify, kobo check, idempotent, Idempotency-Key, insufficient→409 | 14/14 |
| M4 | webhook signature (bad→401/good→200), settle, replay-idempotent, sweeper | 10/10 |
| M5 | state machine legal/illegal(409), refund restores stock, cancel releases | 14/14 |
| M6 | dashboard authZ (401/403/200), filter/search, payment+inventory reads, cancel/refund/release, reason-required, audit | 13/13 |
| M8 | rollback (flags off → legacy + 404s) + regression (18/18 products, identity intact) | pass |

Admin-dashboard-only re-verification (flag on):
```
GET /api/admin/orders   no token → 401   customer → 403   admin → 200
list/filter/search → 200 ; drawer get/payments/inventory → 200
release(non-reserved) → 409 ; cancel(no reason) → 400 ; cancel(reason) → 200 ; refund(cancelled) → 409
CommerceAuditLog row written: order_cancelled (admin@farmtokitchen.com)
admin.html → 200, dashboard markup served
```

Boot-job proof:
```
flags OFF : "running on http://localhost:5050"            jobs-start lines = 0
flags ON  : "Phase 3 commerce integrity ON — reservation sweeper + reconciliation started"  = 1
```

Dormant-state proof (resting :5050, no flags):
```
GET /api/health        → 200
GET /api/products      → 200 (18 products)
GET /api/admin/orders  → 404 {"message":"Admin orders dashboard is not enabled."}
POST /api/payments/webhook → 404
```

## 7. Rollback tags & commands

```
git reset --hard phase3-runbook    # 70d367c — Phase 3 code + docs
git reset --hard phase3-verified   # 9139b75 — Phase 3 code (flags-off)
git reset --hard pre-phase3        # 3a93f6b — pre-Phase 3 baseline
```
Feature rollback (no code change): unset the Phase 3 flags and restart → legacy
behavior, `/api/admin/*` + webhook 404, jobs off, added fields/collections inert.
Data restore: stop app → restore `backups/<timestamp>/` → restart.

## 8. Activation sequence

Pre-flight: replica set confirmed · real `PAYSTACK_SECRET_KEY` · `ALLOW_SIMULATED_PAYMENTS` OFF · `node utils/backupDb.js` · `node utils/migrateCommerce.js`.

Order (verify each before the next — see `PHASE3_ACTIVATION_RUNBOOK.md`):
1. `ENABLE_COMMERCE_INTEGRITY=true`
2. `ENABLE_PAYMENT_WEBHOOK=true` (+ register webhook URL in Paystack)
3. `ENABLE_ADMIN_ORDERS_DASHBOARD=true`
4. `ENABLE_GATEWAY_REFUND=true` (last; after refund-policy reconciliation)

## 9. Known limitations

- **Dashboard action buttons** (cancel/refund/release) are always rendered; **state validity is enforced server-side** (409), not by hiding controls in the UI.
- **Webhook correlation** relies on `data.metadata.orderId` (checkout now sends it) or `transactionRef`; charges lacking both are logged (`PaymentEvent type:"webhook" status:"no_order"`) and not auto-settled.
- **Reconciliation job** only settles Awaiting-Payment orders that already carry a `transactionRef`, and is a no-op without a real Paystack key.
- **Gateway refund** path was not exercised against a live Paystack account (no production key in the test environment); verify in staging before enabling §4.
- **Currency** handling assumes NGN (kobo); multi-currency is not implemented.
- **Order-ID counter** (`counters/order-2026`) advanced during testing, so the first production order ID will not be `…000001` (gap-free, not zero-based — cosmetic).
- **No automated CI suite**; verification was scripted/manual against Atlas.
- **Carryover prod hardening (not Phase 3 scope):** `NODE_ENV=production` + Secure cookies, rotate the seeded admin password, enable admin MFA — see Deployment Checklist.

## 10. Current safe state

- Code committed (`70d367c`, tag `phase3-runbook`); only `.claude/settings.local.json` (harness-managed) is uncommitted.
- All Phase 3 flags **OFF** → backend dormant: products 200, `/api/admin/*` 404, webhook 404, jobs not started.
- Database unchanged by activation: 18 products, 0 orders, 1 user; new commerce collections present and empty (`counters` holds the test-run sequence only).
- Identity / Phase 2.5 admin MFA untouched. Phase 4 not started.
