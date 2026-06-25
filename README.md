# Farm To Kitchen — Full-Stack (Node + Express + MongoDB)

E-commerce app converted from a localStorage prototype to a real backend architecture.

```
farm-to-kitchen/
├── client/                # Frontend (HTML/CSS/JS) — served as static files
│   ├── index.html         # Storefront
│   ├── admin.html         # Admin dashboard / inventory / orders
│   ├── account.html       # Customer account (own orders only)
│   ├── checkout.html      # Checkout + Paystack
│   ├── payment.html
│   ├── style.css
│   ├── script.js
│   └── api.js             # ← API client (talks to the backend)
└── server/                # Backend (Node + Express + MongoDB)
    ├── server.js          # App entry — also serves client/
    ├── config/db.js       # Mongoose connection
    ├── models/            # User, Product, Order, Payment, Inventory, ActivityLog
    ├── middleware/        # auth (JWT), admin, errorHandler
    ├── controllers/       # auth, user, product, order, payment, analytics
    ├── routes/            # REST route definitions
    ├── utils/             # seed.js (migration), activity.js
    └── .env.example
```

## Tech
Node.js · Express · MongoDB · Mongoose · JWT · bcryptjs · Paystack (server-side verify)

## Security & operations docs
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — identity/auth/session architecture (Phase 2.1–2.5; admin MFA **locked**)
- [docs/DEPLOYMENT_CHECKLIST.md](docs/DEPLOYMENT_CHECKLIST.md) — env vars, feature flags, go-live steps
- [docs/OPERATIONS_RECOVERY.md](docs/OPERATIONS_RECOVERY.md) — admin MFA reset, lockouts, rollback, backup/restore
- [docs/PHASE_3_DESIGN.md](docs/PHASE_3_DESIGN.md) — Commerce Integrity & Checkout Hardening (**implemented**, flags default-off)
- [docs/PHASE3_ACTIVATION_RUNBOOK.md](docs/PHASE3_ACTIVATION_RUNBOOK.md) — Phase 3 flag-by-flag activation, verification & rollback runbook

---

## 1. Prerequisites
- **Node.js 18+**
- **MongoDB** — either local (`mongod`) or a free **MongoDB Atlas** cluster

## 2. Install
```bash
cd server
npm install
```

## 3. Configure environment
```bash
cp .env.example .env
```
Edit `.env`:
```
MONGODB_URI=mongodb://127.0.0.1:27017/farm_to_kitchen
JWT_SECRET=<a long random string>
PAYSTACK_SECRET_KEY=sk_test_xxxxxxxx
PORT=5050
CLIENT_ORIGIN=http://localhost:3000
SEED_ADMIN_EMAIL=admin@farmtokitchen.com
SEED_ADMIN_PASSWORD=admin1234
```

> **Ports:** backend API runs on **http://localhost:5050**, frontend on **http://localhost:3000**.
> (`mongodb://127.0.0.1:27017` is just MongoDB's local address — unrelated to the app ports.)

## 4. Seed the database (creates admin + restores default products)
```bash
npm run seed
```
Creates the admin user and **ensures the four default products exist** —
**Rice, Beans, Ofada Rice, Plantain Flour**. The seed is idempotent: re-run it any time
to restore missing defaults without creating duplicates (matched by SKU).

### (Optional) migrate your existing browser data
In the **old app's** browser console:
```js
copy(JSON.stringify({
  products: JSON.parse(localStorage.getItem("ftk_products") || "[]"),
  orders:   JSON.parse(localStorage.getItem("orderHistory") || "[]")
}))
```
Save the clipboard into `server/import.json`, then:
```bash
node utils/seed.js import.json
```

## 5. Run

Two terminals (recommended — keeps the requested 3000 / 5050 split):
```bash
# terminal 1 — backend API on :5050
npm start          # or: npm run dev  (auto-reload with nodemon)

# terminal 2 — frontend on :3000
npm run client
```
Open **http://localhost:3000**. The frontend calls the API at **http://localhost:5050**
(configured in `client/api.js`; CORS allows `http://localhost:3000`).

> The backend also serves the client at `http://localhost:5050` as a fallback, but the
> intended setup is frontend **:3000** + backend **:5050**.

---

## REST API

| Method | Endpoint                 | Access   | Purpose                            |
|--------|--------------------------|----------|------------------------------------|
| POST   | `/api/register`          | public   | Create account → returns JWT       |
| POST   | `/api/login`             | public   | Login → returns JWT                |
| POST   | `/api/logout`            | public   | (stateless) client drops token     |
| GET    | `/api/me`                | auth     | Current user                       |
| GET    | `/api/users`             | admin    | List users                         |
| GET    | `/api/products`          | public   | List products                      |
| POST   | `/api/products`          | admin    | Create product                     |
| PUT    | `/api/products/:id`      | admin    | Update product / stock             |
| DELETE | `/api/products/:id`      | admin    | Delete product                     |
| GET    | `/api/orders`            | auth     | Admin → all; customer → own only   |
| POST   | `/api/orders`            | guest/ok | Create order (Awaiting Payment)    |
| PUT    | `/api/orders/:id/status` | admin    | Update order status                |
| POST   | `/api/payments`          | guest/ok | Verify Paystack ref → mark Paid    |
| GET    | `/api/payments`          | admin    | List payments                      |
| GET    | `/api/analytics`         | admin    | Dashboard metrics                  |

### Auth
Send the JWT on protected calls:
```
Authorization: Bearer <token>
```

### Security highlights
- Passwords hashed with **bcrypt** (10 salt rounds), never returned.
- **JWT** (7-day expiry) signed with `JWT_SECRET`.
- Payments are verified **server-side** against Paystack with the **secret key** before an order is marked `Paid` — the browser cannot fake a payment.
- Customers can only read **their own** orders; the full list is admin-only (enforced in the controller, not just the UI).

---

## Connecting the frontend
Each page includes `api.js` and calls `window.API`. Example (login):
```js
await API.login(email, password);   // stores token + user
const orders = await API.orders.list();   // customer → own orders
```
Paystack flow on checkout:
```js
const order = await API.orders.create({ customerName, customerEmail, items, ... });
// open Paystack inline with order.grandTotal, then on success:
await API.payments.confirm(response.reference, order.orderId);
```

> Note: the HTML pages in `client/` still contain the original localStorage logic so
> the app keeps working during migration. Swap each page's data calls to the matching
> `API.*` method (see table above) to move it fully onto the backend.
