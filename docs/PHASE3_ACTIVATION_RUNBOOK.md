# Phase 3 — Activation Runbook

_Operational runbook for turning on Phase 3 (Commerce Integrity & Checkout
Hardening) in production. Documentation only._

- **Code state:** committed `9139b75` (tag `phase3-verified`); rollback baseline tag
  `pre-phase3` (`3a93f6b`).
- **Default state:** every Phase 3 flag is **OFF / dormant** (verified). Activating
  is purely an environment + restart operation — **no code change**.
- **Activate in order:** §1 → §2 → §3 → §4. Verify each before the next.
- **Pre-flight (once, before §1):**
  - Confirm MongoDB is a **replica set** (Atlas is) — multi-document transactions are required.
  - Real `PAYSTACK_SECRET_KEY` set (no `xxxx` placeholder).
  - **`ALLOW_SIMULATED_PAYMENTS` must be unset/OFF in production.**
  - Take a DB backup: `node utils/backupDb.js`.
  - Run the additive, idempotent migration (creates collections + indexes):
    `node utils/migrateCommerce.js` → expect `products updated 0/N, orders updated 0/N` on a second run.

> Flag semantics (read from code): a flag is ON only when its env var === `"true"`.
> Unsetting it (or any other value) = OFF. All commands below assume the server is
> started from `server/` (`node server.js`).

---

## 1. `ENABLE_COMMERCE_INTEGRITY`

Switches order create / payment confirm / status update to the hardened, transactional
implementations; on boot, ensures commerce collections exist and starts the reservation
sweeper + reconciliation jobs.

**Enable**
```
ENABLE_COMMERCE_INTEGRITY=true
# optional tunables (defaults shown):
RESERVATION_TTL_MIN=30
DEFAULT_DELIVERY_FEE=3000
RESERVATION_SWEEP_INTERVAL_MS=60000
RECONCILE_INTERVAL_MS=300000
# restart the backend
```

**Expected results**
- Boot log contains: `✔ Phase 3 commerce integrity ON — reservation sweeper + reconciliation started`.
- `POST /api/orders` re-prices every line from the DB (client `price`/`total`/paid-state ignored), creates the order **Awaiting Payment**, and **reserves** stock (`inventoryState:"reserved"`, `reservationExpiresAt = now + RESERVATION_TTL_MIN`).
- `POST /api/payments` requires a verified charge, checks amount in **kobo** + currency vs `serverGrandTotal`, commits stock idempotently.
- `PUT /api/orders/:id/status` is state-machine validated (illegal transition → 409).
- `available = stock − reserved`; concurrent orders cannot oversell.

**Verification commands**
```bash
# boot proof
grep "commerce integrity ON" <server-log>          # → 1 line

# health + catalog unaffected
curl -s -o /dev/null -w "%{http_code}\n" http://<host>/api/health     # 200
curl -s -o /dev/null -w "%{http_code}\n" http://<host>/api/products   # 200

# (staging) functional proof — re-pricing + reservation, then read it back
#   create returns server grandTotal (NOT the client price) and inventoryState "reserved"
curl -s -X POST http://<host>/api/orders -H 'Content-Type: application/json' \
  -d '{"customerName":"RB","customerEmail":"rb@test","customerAddress":"x",
       "items":[{"product":"<PRODUCT_ID>","name":"<NAME>","units":1,"price":1}]}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log("grandTotal",o.grandTotal,"status",o.status,"inv",o.inventoryState)})'
#   expect: grandTotal = DB price + delivery fee, status "Awaiting Payment", inv "reserved"

# idempotent migration (collections/indexes present)
node utils/migrateCommerce.js                      # products updated 0/N, orders updated 0/N
```

**Rollback**
```
unset ENABLE_COMMERCE_INTEGRITY   (or set ≠ "true")
# restart backend
```
- Effect: order create/confirm/status revert to the **legacy** code path; the sweeper/reconciliation jobs do **not** start; added fields/collections are inert. No data migration to undo. Verify boot log has **no** "commerce integrity ON" line.

---

## 2. `ENABLE_PAYMENT_WEBHOOK`

Exposes the Paystack signature-verified webhook (the settlement safety net). Requires §1 ON for settlement to commit inventory.

**Enable**
```
ENABLE_PAYMENT_WEBHOOK=true
# restart backend, then in the Paystack dashboard register:
#   Webhook URL: https://<host>/api/payments/webhook
```

**Expected results**
- `POST /api/payments/webhook` returns **401** for a bad/missing `x-paystack-signature`, **200** for a valid signature (HMAC-SHA512 of the raw body keyed by `PAYSTACK_SECRET_KEY`).
- A valid `charge.success` whose `data.metadata.orderId` (or `transactionRef`) matches an open order settles it idempotently (→ Paid, committed). Replays do not double-commit.
- The checkout client already sends `metadata.orderId` so the webhook can correlate.

**Verification commands**
```bash
# OFF baseline first (before enabling): expect 404
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://<host>/api/payments/webhook   # 404 when OFF

# After enabling: bad signature → 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://<host>/api/payments/webhook \
  -H 'x-paystack-signature: deadbeef' -H 'Content-Type: application/json' -d '{}'      # 401

# Valid signature (staging): compute HMAC-SHA512 over the EXACT body bytes
node -e 'const c=require("crypto");const k=process.env.PAYSTACK_SECRET_KEY;
  const b=JSON.stringify({event:"charge.success",data:{reference:"WH-TEST",amount:300000,currency:"NGN",metadata:{orderId:"<ORDER_ID>"}}});
  console.log("sig="+c.createHmac("sha512",k).update(b).digest("hex"));console.log("body="+b)'
# then POST that body with header x-paystack-signature: <sig> → 200, order becomes Paid

# confirm settlement (staging)
curl -s http://<host>/api/admin/orders/<ORDER_ID>/payments -H "Authorization: Bearer <ADMIN_TOKEN>"
```

**Rollback**
```
unset ENABLE_PAYMENT_WEBHOOK
# restart backend
```
- Effect: `POST /api/payments/webhook` → **404**. Settlement still works via `POST /api/payments` (confirm) and the reconciliation job (when §1 ON). Optionally disable the webhook in the Paystack dashboard.

---

## 3. `ENABLE_ADMIN_ORDERS_DASHBOARD`

Exposes the back-office `/api/admin/*` routes (reads + cancel/refund/release). Each route runs behind `apiLimiter → dashboardOn → protect → admin`; an MFA-enrolled admin still cannot reach them without MFA (Phase 2.5 lock unchanged).

**Enable**
```
ENABLE_ADMIN_ORDERS_DASHBOARD=true
# restart backend
```

**Expected results**
- 9 routes reachable: `GET /api/admin/orders`, `/orders/:id`, `/orders/:id/payments`, `/orders/:id/inventory`, `/payments`, `/inventory`; `POST /orders/:id/cancel`, `/orders/:id/refund`, `/orders/:id/release`.
- Auth: **401** (no token), **403** (customer token), **200** (admin token).
- Actions require a `reason` (**400** if missing); invalid state transitions → **409**; every action writes a `CommerceAuditLog` row (admin, before→after, reason).
- `admin.html` shows a "📦 Orders" launcher → dashboard (table, filter, search, drawer, cancel/refund/release).

**Verification commands**
```bash
# OFF baseline: 404
curl -s -o /dev/null -w "%{http_code}\n" http://<host>/api/admin/orders          # 404 when OFF

# After enabling — authZ matrix
curl -s -o /dev/null -w "no-token   %{http_code}\n" http://<host>/api/admin/orders                          # 401
curl -s -o /dev/null -w "customer   %{http_code}\n" http://<host>/api/admin/orders -H "Authorization: Bearer <CUSTOMER_TOKEN>"  # 403
curl -s -o /dev/null -w "admin      %{http_code}\n" http://<host>/api/admin/orders -H "Authorization: Bearer <ADMIN_TOKEN>"     # 200

# reason-required + state validity (staging, on a known order)
curl -s -o /dev/null -w "no-reason  %{http_code}\n" -X POST http://<host>/api/admin/orders/<OID>/cancel \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H 'Content-Type: application/json' -d '{}'                       # 400
curl -s -o /dev/null -w "bad-state  %{http_code}\n" -X POST http://<host>/api/admin/orders/<OID>/release \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H 'Content-Type: application/json' -d '{"reason":"x"}'           # 409 if not reserved

# admin token (MFA dormant → password login)
curl -s -X POST http://<host>/api/admin/login -H 'Content-Type: application/json' \
  -d '{"email":"<ADMIN_EMAIL>","password":"<ADMIN_PASSWORD>"}'
```

**Rollback**
```
unset ENABLE_ADMIN_ORDERS_DASHBOARD
# restart backend
```
- Effect: all `/api/admin/*` routes → **404** (`{"message":"Admin orders dashboard is not enabled."}`); the `admin.html` launcher reports "not enabled". Order processing (§1/§2) is unaffected.

---

## 4. `ENABLE_GATEWAY_REFUND`

Makes the admin **Refund** action additionally call the Paystack refund API. Requires §3 ON (the refund action lives in the dashboard). Enable **last**, after reconciling with your refund policy.

**Enable**
```
ENABLE_GATEWAY_REFUND=true
# restart backend
```

**Expected results**
- With OFF: admin refund = local only (`Refunded` + stock restore + `CommerceAuditLog`); you refund the customer manually in Paystack.
- With ON: a refund on an order with a `transactionRef` also calls Paystack `/refund`, records a `PaymentEvent{type:"refund"}` and a `CommerceAuditLog{action:"gateway_refund"}`. A gateway error is logged and does **not** revert the local refund.

**Verification commands**
```bash
# (staging) refund a paid order, then inspect events for the gateway refund
curl -s -X POST http://<host>/api/admin/orders/<PAID_OID>/refund \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H 'Content-Type: application/json' \
  -d '{"reason":"runbook gateway-refund test"}'
curl -s http://<host>/api/admin/orders/<PAID_OID>/payments -H "Authorization: Bearer <ADMIN_TOKEN>"
#   expect a PaymentEvent type "refund"; CommerceAuditLog action "gateway_refund"
```
> Verify against a real Paystack test transaction; do not test gateway refunds with `ALLOW_SIMULATED_PAYMENTS` references (no real charge exists to refund).

**Rollback**
```
unset ENABLE_GATEWAY_REFUND
# restart backend
```
- Effect: admin refunds become local-only again (status + stock + audit); no gateway call. Already-issued gateway refunds are not reversed by this flag.

---

## 5. Emergency rollback procedure

**Fastest — disable the feature (code unchanged), preferred for an incident:**
```bash
# unset ALL Phase 3 flags, then restart production-safe (no flags):
#   ENABLE_COMMERCE_INTEGRITY, ENABLE_PAYMENT_WEBHOOK, ALLOW_SIMULATED_PAYMENTS,
#   ENABLE_ADMIN_ORDERS_DASHBOARD, ENABLE_GATEWAY_REFUND
kill $(lsof -ti :5050); node server.js          # or your process manager's restart
```
Dormant-state confirmation:
```bash
curl -s -o /dev/null -w "products %{http_code}\n" http://<host>/api/products            # 200
curl -s -o /dev/null -w "admin    %{http_code}\n" http://<host>/api/admin/orders         # 404
curl -s -o /dev/null -w "webhook  %{http_code}\n" -X POST http://<host>/api/payments/webhook  # 404
grep -c "commerce integrity ON" <server-log>                                              # 0
```
With flags off: order create/confirm run the legacy path; added fields/collections are inert; **no oversell engine, no jobs, no admin routes, no webhook**.

**Full code revert (if a code defect is implicated):**
```bash
git reset --hard phase3-verified    # 9139b75 — Phase 3, flags-off
git reset --hard pre-phase3         # 3a93f6b — pre-Phase 3 baseline
# restart backend
```

**Data restore (only if a migration/data issue):**
```bash
# stop app → restore backups/<timestamp>/ into the database → restart → re-run §5 dormant checks
```

**Notes**
- The four Phase 3 collections (`counters`, `stockledgers`, `paymentevents`, `commerceauditlogs`) are additive and inert when flags are off; they may be left in place. Drop only deliberately.
- Identity / Phase 2.5 admin MFA are untouched by all Phase 3 flags.
