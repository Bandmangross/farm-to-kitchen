# Phase 3 — Commerce Integrity & Checkout Hardening (Design)

_Status: **IMPLEMENTED & VERIFIED** (flags default-off / dormant) · 2026-06-25_

> Implemented across milestones M1–M8 with per-milestone verification. All behind
> default-off flags (see Deployment Checklist §3/§4c). Backend left production-safe
> with Phase 3 dormant. Git rollback point: tag `pre-phase3`.

**Scope:** order creation, server-authoritative pricing, inventory consistency,
payment verification, order lifecycle, and an Admin Orders Dashboard.
**Out of scope / unchanged:** all identity (Phase 2.1–2.6) and the **LOCKED**
admin MFA/auth surface (Phase 2.5) — the new admin endpoints only *reuse* the
existing `protect, admin` guard; no auth/MFA/session code is modified.

Process (same as prior phases): design → locks (below) → DB backup → implement →
live verify → rollback verify → regression → production-safe restart → evidence.

---

## 0. Locked decisions

| # | Decision | Locked choice |
|---|----------|---------------|
| 1 | Pricing authority | **Full server-side re-pricing** on every order; client price/total ignored |
| 2 | Inventory model | **Reserve-on-create + commit-on-payment**, reservation **TTL = 30 min** |
| 3 | Payments | Add **signature-verified webhook** + reconciliation job; simulation behind a **dev-only flag** |
| 4 | Transactions | **MongoDB multi-document transactions** (Atlas replica set) |
| 5 | Bug R7 | **Fix variant-quantity under-deduction** within Phase 3 |
| 6 | Order state machine | Adopt the **single lifecycle** (collapse status/paymentStatus drift) |
| 7 | Rollout | All behind **default-off feature flags**, staged cutover |
| 8 | Refund money | v1 = local `Refunded` + stock restore + audit; **actual gateway refund behind `ENABLE_GATEWAY_REFUND`** |
| 9 | Manual release | **Frees the reservation; order remains `Awaiting Payment`; NO automatic cancellation** |
| 10 | Audit store | **Dedicated `CommerceAuditLog`** |
| 11 | API namespace | **New `/api/admin/*`** for back-office reads/actions |

---

## 1. Current commerce risks (grounded in the code)

| # | Risk | Where | Severity |
|---|------|-------|----------|
| R1 | **Client sets line prices.** `create()` uses `price = Number(it.price)`, `total += price`; server never re-prices. | orderController.js:53‑62 | Critical |
| R2 | **Client self-declares paid.** `isPaid = req.body.paymentStatus === "Paid"` → Paid order + stock deducted, no verification. | orderController.js:72,83‑94 | Critical |
| R3 | **Forgeable payments.** Missing/placeholder key or `SIMULATED-` ref fabricates `success`. | paymentController.js:45‑49 | Critical |
| R4 | **Self-referential amount check** vs client-derived `grandTotal`. | paymentController.js:57 | Critical |
| R5 | **Unauthenticated, replayable confirm**; no already-Paid guard. | payments.js:6 | High |
| R6 | **Inventory race / oversell** — read-modify-write, no txn, TOCTOU, silent clamp. | inventory.js:90‑162 | High |
| R7 | **Variant under-deduction** — adds `Number(it.count)||1` but items carry `units`/`quantity`. | inventory.js:54 | High (latent) |
| R8 | **Order-ID race** — findOne+`n+1`, not atomic. | orderController.js:6‑16 | Medium |
| R9 | **No state-machine integrity**; status/paymentStatus drift; cancel/refund don't restock. | orderController.js:104‑127 | Medium |
| R10 | **No webhook/settlement net** — depends on browser calling confirm. | absent | Medium |
| R11 | **No rate limiting / abuse controls**; guest PII plaintext; order enumeration. | orders.js, payments.js | Medium |

## 2. Threat model
- **Actors:** anonymous client, customer, compromised customer, malicious/curious admin, payment gateway, concurrent buyers.
- **Assets:** money (charge/settlement), inventory truth, order integrity, customer PII.
- **Threats:** price tampering (R1/R4); payment spoofing (R2/R3/R5); race/oversell/double-apply (R6/R7); DoS/abuse & order-ID collisions (R8/R11); order/PII enumeration (R5/R11); admin abuse of cancel/refund/release (→ audited, §8).
- **Trust boundaries:** browser→API never trusts price/total/paid-state/stock; API→Paystack trusts only a server-side TLS `verify` with the secret key (kobo, server-computed total); API→DB integrity via transactions + atomic conditional writes.

## 3. Database changes (additive, backward-compatible)
- **Order:** `currency` (default `NGN`), `serverTotal`/`serverGrandTotal` (authoritative), per-line `pricingSnapshot` (`productId`, `variantLabel`, `unitPrice`, `qty`, `lineTotal`), `idempotencyKey` (unique), `version` (optimistic concurrency), `statusHistory[]` (`from,to,actor,reason,at`), `inventoryState` enum (`none|reserved|committed|released`), `reservationExpiresAt`.
- **Product/variant:** `reserved` (per variant and per legacy product); available = `stock − reserved`. `stock` stays the source of truth.
- **`StockLedger`** (new, or extend Inventory): immutable movements `reserve|commit|release|restock|refund|adjust` with `orderId`, `before/after`, actor, reason; unique key `(orderId, type)` for idempotency.
- **`PaymentEvent`** (new, or extend Payment): append-only gateway events `initialized|verified|webhook|mismatch|duplicate|refund`; dedup on `reference` and `(orderId,status)`.
- **`CommerceAuditLog`** (new, decision 10): `{ admin, action, orderId, before, after, amount?, reason, ip, at }`; append-only; indexed by `orderId`, `admin`, `at`.
- **`Counter`** (new): atomic gap-free `orderId` via `findOneAndUpdate($inc)` (fixes R8).
- Backfill is idempotent; existing 0 orders / 18 products migrate trivially; all new fields inert when flags off.

## 4. API changes
- **`POST /api/orders` (create):** ignore client `price`/`total`/`paymentStatus`/`status`; **re-price every line from the DB** (active product + matched variant); compute server totals; server-set delivery fee; always `Awaiting Payment` + `inventoryState:"reserved"` with `reservationExpiresAt = now + 30m`; accept **`Idempotency-Key`**; rate-limited.
- **`POST /api/payments` (confirm):** require order `Awaiting Payment`; **always** verify with Paystack (simulation only when `ALLOW_SIMULATED_PAYMENTS=true`, never from a missing key); compare gateway **kobo** + currency to the **server** grandTotal; idempotent on `reference` and already-`Paid`; **commit** reservation atomically; write `PaymentEvent`.
- **`POST /api/payments/webhook` (new):** Paystack `x-paystack-signature` HMAC-SHA512 verified; idempotent settlement (safety net for R10).
- **Reconciliation job (new):** periodically compares local `Awaiting Payment` orders with Paystack.
- **Reservation sweeper (new):** releases reservations past `reservationExpiresAt` (order stays `Awaiting Payment` for re-attempt or admin action).
- **Admin back-office — new `/api/admin/*` namespace (decision 11), all `protect, admin`, rate-limited** — see §8.
- **Legacy `PUT /api/orders/:id/status`:** retained but routed through the state machine (§5).

## 5. Order lifecycle (single authoritative state machine — decision 6)
```
CREATED (Awaiting Payment, reserved)
   ├─ pay verified ─────────────► PAID (committed)
   │                                 ├─ admin ► PROCESSING ► SHIPPED ► DELIVERED
   │                                 └─ admin refund ► REFUNDED  (restore committed stock)
   ├─ admin cancel ─────────────► CANCELLED            (release reservation)
   ├─ reservation TTL expires ──► Awaiting Payment, reservation released
   │                              (decision 9: NO auto-cancel; stock freed; order stays open)
   └─ admin manual release ─────► Awaiting Payment, reservation released (decision 9)
```
- Allowed transitions only (else 409); each appends `statusHistory` and runs in a transaction with its inventory effect so order state and stock never disagree.

## 6. Inventory consistency strategy
- **Reserve-then-commit** (decision 2), not check-then-deduct. Create: atomic conditional `$inc reserved` only where `stock − reserved ≥ need` (single `findOneAndUpdate` per line = oversell guard, replaces R6 TOCTOU). Payment: `reserved → committed` (`$inc stock -n`, `$inc reserved -n`). Cancel/expire/manual-release: release `reserved`. Refund: restore `stock`.
- **MongoDB multi-doc transactions** (decision 4) wrap multi-line order + ledger writes.
- **Idempotency** via `inventoryState` + `version` (optimistic concurrency) + unique ledger key `(orderId,type)`; double confirm/webhook cannot double-apply.
- **Fix R7** (decision 5): deduct the real ordered quantity per variant line.
- No silent zero-clamp — a would-be-negative decrement fails and surfaces as insufficient stock.

## 7. Payment verification strategy
- **Server-authoritative amount** in **kobo** + currency match vs server `grandTotal` (closes R1/R4).
- **Mandatory gateway verify**; simulation only behind `ALLOW_SIMULATED_PAYMENTS` (dev), never inferred from a missing/placeholder key (closes R3).
- **No client-declared paid** (closes R2).
- **Idempotent settlement**: unique `reference`; already-`Paid` → return existing, no re-commit; `PaymentEvent` records duplicates/mismatches.
- **Webhook + reconciliation** as source of truth (closes R10).
- Confirm requires an open order; rate-limited; every attempt logged to `PaymentEvent`.

## 8. Admin Orders Dashboard

Back-office over the §5 state machine, ledger, and `PaymentEvent`. All routes
behind the existing `protect, admin` chain → an MFA-enrolled admin still cannot
reach them without MFA (Phase 2.5 lock preserved, **untouched**).

| Requirement | Endpoint (`/api/admin/*`) | Backing data |
|---|---|---|
| View all orders | `GET /orders` (paginated/sortable) | Order (server totals, `inventoryState`, state) |
| Filter by status | `GET /orders?status=` (+ payment status) | Order (enum-validated) |
| Search by order ID | `GET /orders?orderId=` (exact + `FTK-YYYY-` prefix; + email) | Order |
| View payment history | `GET /orders/:id/payments`, `GET /payments` | Payment / `PaymentEvent` (append-only timeline) |
| View inventory movements | `GET /orders/:id/inventory`, `GET /inventory` | `StockLedger` (**new read surface** — none today) |
| Cancel order | `POST /orders/:id/cancel` | Order + ledger (txn); from Awaiting/Processing; releases reservation |
| Refund order | `POST /orders/:id/refund` | Order + Payment + ledger (txn); from Paid/Delivered; restores stock; refund `PaymentEvent`; gateway call only if `ENABLE_GATEWAY_REFUND` |
| Manually release reservation | `POST /orders/:id/release` | Order + ledger (txn); **frees reservation, order stays `Awaiting Payment`, no cancel** (decision 9) |
| Audit trail for all actions | every mutating call → `CommerceAuditLog` | new collection (before→after, admin, reason, ip, at) |

- **Mutating actions are transactional**: order transition + inventory effect + ledger + `CommerceAuditLog` commit/roll back together; optimistic-concurrency (`version`); idempotent on repeat; **reason required**.
- **Refund money (decision 8):** v1 marks `Refunded` + restores stock + audit; actual `paystack.refund` only when `ENABLE_GATEWAY_REFUND=true` (off by default).
- **Client:** new **Orders panel** in `admin.html` (table + status filter + order-ID/email search + row drawer: payment history, inventory movements, status history; Cancel/Refund/Release each prompt for a reason + confirm). Uses `API.admin.*` via the existing admin token slot. **The admin login/MFA gate JS is not modified.**

## 9. Rollback plan & feature flags

| Flag | Gates | Default |
|------|-------|---------|
| `ENABLE_COMMERCE_INTEGRITY` | server re-pricing + reserve/commit inventory model | **off** |
| `ENABLE_PAYMENT_WEBHOOK` | signature-verified webhook settlement | **off** |
| `ALLOW_SIMULATED_PAYMENTS` | dev-only simulated payment path | **off** |
| `ENABLE_ADMIN_ORDERS_DASHBOARD` | `/api/admin/*` routes + admin panel | **off** |
| `ENABLE_GATEWAY_REFUND` | real Paystack refund call on refund action | **off** |

- Flags off → current create/confirm/deduct + `GET /api/orders` + `PUT /:id/status` behave exactly as today; new endpoints 404; new collections/fields inert.
- New DB fields/collections additive; backfill idempotent and reversible; **no destructive migration**.
- **Staged cutover:** `ENABLE_COMMERCE_INTEGRITY` (watch oversell/ledger metrics) → `ENABLE_PAYMENT_WEBHOOK` → `ENABLE_ADMIN_ORDERS_DASHBOARD`; `ENABLE_GATEWAY_REFUND` last, deliberately. Each independently reversible.
- DB backup via `backupDb.js` before changes; documented restore.

## 10. Testing checklist
- **Pricing:** client price/total tampering ignored; DB price authoritative; variant vs legacy; archived/draft product rejected.
- **Paid-state spoofing:** `paymentStatus:"Paid"` on create ignored (no stock moved).
- **Payment:** real verify; amount/currency mismatch rejected; simulation only with dev flag; duplicate `reference` idempotent; confirm on already-Paid is a no-op; webhook signature valid/invalid; webhook + confirm don't double-commit.
- **Inventory concurrency:** N parallel orders for the last unit → exactly one succeeds, no oversell, ledger balances; reservation release on cancel/expire/manual-release; refund restores stock; variant multi-quantity correct (R7).
- **State machine:** illegal transitions 409; cancel/refund inventory effects; manual release keeps order Awaiting Payment (decision 9); `statusHistory` recorded.
- **Order ID:** parallel creates unique/sequential (R8).
- **Admin dashboard:** every `/api/admin/*` route 403 for non-admin and (MFA on) 403 without MFA; filter/search/pagination correctness; each action writes exactly one `CommerceAuditLog` with before→after + admin + reason; cannot refund an unpaid order (409); double-action idempotent.
- **Rollback:** flags off → legacy intact; flags on → hardened behavior.
- **Regression:** products 18/18 + images; customer & admin auth (incl. locked MFA) untouched; pages 200; `/orders/my` scoping intact.

## 11. Production readiness checklist
- Real `PAYSTACK_SECRET_KEY`; `ALLOW_SIMULATED_PAYMENTS` **off**; webhook URL + signing secret registered in Paystack.
- `ENABLE_COMMERCE_INTEGRITY` + `ENABLE_PAYMENT_WEBHOOK` enabled after staged verification; `ENABLE_GATEWAY_REFUND` off until reconciled with refund policy.
- Atlas transactions confirmed (replica set); indexes for `idempotencyKey`, ledger `(orderId,type)`, `CommerceAuditLog(orderId,admin,at)`, counter.
- Reservation-TTL sweeper + reconciliation job scheduled and monitored.
- Rate limiting on order/payment/admin endpoints; commerce-audit retention defined.
- Alerting on oversell-attempt, amount-mismatch, webhook-signature-failure, refund volume, manual-release frequency.
- (Carryover from deferred 2.7) `NODE_ENV=production`, Secure cookies, rotated admin password — money flows must not go live on dev cookies.

---

_Awaiting final approval. No code will be generated until approved. Identity /
Phase 2.5 admin MFA remain locked and untouched; this phase touches commerce only._
