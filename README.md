# Prepaid Smart Fuel Dispensing System

A backend (plus a lightweight web portal) for prepaid fuel purchases: customers top up a
wallet, reserve funds for a fuel request, station staff authorize the pump, and the ledger
settles the final payment and releases any unused reserve.

## Tech Stack

- **Runtime:** Node.js 18+, Express 5
- **Database:** PostgreSQL 15 + Prisma ORM
- **Auth:** JWT access tokens + rotating refresh tokens (bcrypt password hashing)
- **Tooling:** ESLint, Prettier, Docker / docker-compose
- **UI:** Vanilla JS single-page portal served by the API (`public/`)

## Project Structure

```
├── api/openapi.yaml          # OpenAPI 3 contract (served at /docs)
├── esp32-mock/
│   ├── firmware/             # Compilable ESP32 Arduino sketch + config template
│   ├── pump_mock.py          # Python pump-controller mock (no hardware needed)
│   └── requirements.txt
├── migrations/               # Raw SQL migrations (auto-loaded by docker-compose init)
│   ├── 001_initial.sql
│   └── 002_refresh_tokens.sql
├── prisma/
│   ├── schema.prisma         # Prisma data model (mirrors SQL migrations)
│   └── seed.js               # Demo data: fuel types, station, pumps, users
├── public/                   # Web portal (customer, staff, admin)
├── scripts/                  # Self-tests (ledger math, HMAC signature)
├── src/
│   ├── events/eventBus.js    # In-process pub/sub powering the SSE streams
│   ├── jobs/                 # Background expiry job
│   ├── middleware/auth.js    # authenticateToken / authorizeRole
│   ├── models/index.js       # Prisma client singleton
│   ├── routes/               # auth, customers, wallet, fuel-requests, staff,
│   │                         # admin, catalog, device (ESP32), stream (SSE), receipts
│   └── services/             # auth, wallet (ledger), fuel, staff, admin,
│                             # device, receipt, audit
└── test/                     # mocha unit tests (services)
```

## Getting Started

```bash
cp .env.example .env          # adjust if needed
docker compose up -d db       # start PostgreSQL (runs migrations/*.sql on first init)
npm install
npm run db:push               # sync Prisma schema (idempotent safety net)
npm run seed                  # demo data
npm run dev                   # API + portal on http://localhost:4000
```

Or run everything in Docker: `docker compose up --build`.

To also start the Python pump mock (simulates the ESP32 controller; pumps ID 1 and 2):

### Demo Credentials

| Portal   | Login               | Password       | Role      |
| -------- | ------------------- | -------------- | --------- |
| Customer | `john@example.com`  | `customer123`  | customer  |
| Staff    | `admin`             | `admin123`     | admin     |
| Staff    | `attendant`         | `attendant123` | staff     |

> Change `JWT_SECRET` and all demo passwords before any real deployment.

## API Summary

| Method | Path                                | Auth      | Description                              |
| ------ | ----------------------------------- | --------- | ---------------------------------------- |
| POST   | `/api/customers/register`           | –         | Register customer (creates wallet)       |
| POST   | `/api/auth/login`                   | –         | Login (customer email or staff username) |
| POST   | `/api/auth/refresh`                 | –         | Rotate refresh token, new access token   |
| POST   | `/api/auth/logout`                  | –         | Revoke refresh token                     |
| GET    | `/api/wallet`                       | customer  | Wallet balances                          |
| POST   | `/api/wallet/deposit`               | customer  | Cash deposit (ledger `CASH_DEPOSIT`)     |
| GET    | `/api/wallet/transactions`          | customer  | Paginated ledger history                 |
| GET    | `/api/stations`                     | –         | List stations                            |
| GET    | `/api/stations/:id/pumps`           | –         | Pumps for a station                      |
| GET    | `/api/fuel-types`                   | –         | Fuel types + prices                      |
| POST   | `/api/fuel-requests`                | customer  | Create request + reserve wallet funds    |
| GET    | `/api/fuel-requests`                | customer  | List own requests                        |
| POST   | `/api/fuel-requests/:id/cancel`     | customer  | Cancel + release reserved funds          |
| GET    | `/api/staff/fuel-requests`          | staff     | Alias of `/api/staff/pending-requests`   |
| GET    | `/api/staff/pending-requests`       | staff     | Pending (RESERVED/ACCEPTED) requests     |
| POST   | `/api/staff/requests/:id/accept`    | staff     | Accept: keep reservation, status ACCEPTED |
| POST   | `/api/staff/requests/:id/assign-pump` | staff     | Stage 8: hold a pump for a request       |
| POST   | `/api/staff/requests/:id/reject`    | staff     | Reject: release reservation, status REJECTED |
| POST   | `/api/staff/fuel-requests/:id/authorize` | staff | Authorize pump (FuelTransaction)       |
| POST   | `/api/staff/fuel-requests/:id/cancel`    | staff | Cancel + release                        |
| GET    | `/api/staff/fuel-transactions`      | staff     | Station transaction log                  |
| POST   | `/api/staff/fuel-transactions/:id/complete` | staff | Complete dispense, settle ledger     |
| GET    | `/api/transactions/:id`             | owner     | Transaction detail + receipt URL         |
| GET    | `/api/stream/pumps/:pump_id`        | owner²    | SSE — live dispensing progress           |
| GET    | `/api/stream/station`               | staff     | SSE — all pumps at caller's station      |
| GET    | `/api/stream/me`                    | customer  | SSE — wallet, requests, dispensing       |
| POST   | `/api/esp32/authorizations/:pump_id/status` | device¹ | Telemetry `{current_litres, pump_state}` |
| POST   | `/api/esp32/authorizations/:pump_id/completed` | device¹ | Final report → settle + receipt    |
| GET    | `/api/admin/dashboard`              | admin     | Cards: counts, litres/revenue today, audit |
| GET/PATCH | `/api/admin/users(/:id/status)`  | admin     | User list, block/unblock                 |
| GET/POST/PATCH | `/api/admin/stations(/:id)`  | admin     | Station CRUD                             |
| GET/POST/PATCH/DELETE | `/api/admin/pumps(/:id)` | admin  | Pump CRUD                                |
| GET/POST/PATCH | `/api/admin/staff(/:id)`      | admin     | Staff account CRUD                       |
| GET    | `/api/admin/audit-logs`             | admin     | Filterable audit trail                   |
| GET    | `/docs`                             | –         | Swagger UI (OpenAPI inspector)           |
| GET    | `/api/esp32/authorizations/:pump_id` | device¹   | Signed AUTHORIZED transaction for a pump |
| POST   | `/api/esp32/authorizations/:pump_id/ack` | device¹ | Controller reports dispense result      |

<sup>¹</sup> Device endpoints authenticate with the `x-api-key` header (`ESP32_API_KEY`) and are disabled when it is unset.
<sup>²</sup> SSE streams use `?token=<jwt>` (EventSource cannot set headers); authorization rules are identical to the REST API.

Full request/response schemas: [`api/openapi.yaml`](api/openapi.yaml).

## Wallet Ledger

Every balance change writes a `wallet_transactions` row with `balance_before`/`balance_after`
(the balance pool the operation touched) and a unique reference:

| Type           | Effect                                              |
| -------------- | --------------------------------------------------- |
| `CASH_DEPOSIT` | `available_balance += amount`                        |
| `RESERVATION`  | `available → reserved` (fails if insufficient funds) |
| `RELEASE`      | `reserved → available` (cancel or unused remainder)  |
| `FUEL_PAYMENT` | `reserved -= amount` (fuel actually dispensed)       |
| `REFUND`       | `available_balance += amount`                        |

Fuel request lifecycle: `RESERVED → ACCEPTED → AUTHORIZED → COMPLETED` (or `CANCELLED`,
`REJECTED`, `EXPIRED`). Reservations expire after 15 minutes — a background job
(`src/jobs/requestExpiryJob.js`, runs every minute) auto-expires stale RESERVED requests and
releases their funds; expiry is also applied lazily when staff list requests or authorize.
All status flips use a status guard so concurrent expiry/accept/reject paths can never
double-release funds.

## Implementation Plan (Spec)

### Stage 0 – Repository & Tooling ✅
- [x] Initialise Git repository
- [x] Add `.gitignore`
- [x] Create `README.md` with spec copy-paste
- [x] Add `package.json`
- [x] Set up ESLint/Prettier
- [x] Create basic `Dockerfile` & `docker-compose.yml`
- **Deliverable:** Repo skeleton on `main`

### Stage 1 – Architecture & Data Model ✅
- [x] Draft ER diagram (below)
- [x] Write migration script `migrations/001_initial.sql`
- [x] Generate ORM models (`prisma/schema.prisma`, `src/models/`)
- [x] Write OpenAPI spec `api/openapi.yaml`
- **Deliverable:** DB schema + API contract

### Stage 2 – Authentication & Authorization ✅
- [x] JWT (access + refresh) implementation
- [x] Role-based middleware (`customer`, `staff`, `admin`)
- [x] Password hashing with bcrypt
- [x] Endpoints: `POST /auth/login`, `/auth/refresh`, `/auth/logout`
- [x] UI login pages for each portal
- **Deliverable:** Secure sign-in for all roles

### Stage 3 – Customer & Wallet Core ✅
- [x] `POST /customers/register` (creates wallet)
- [x] `GET /wallet` (available / reserved balances)
- [x] `GET /wallet/transactions` (paginated)
- [x] Service that records every balance change as a `wallet_transactions` row
      (`CASH_DEPOSIT`, `RESERVATION`, `RELEASE`, `FUEL_PAYMENT`, `REFUND`)
- [x] UI: Dashboard, Wallet page, Transaction history
- **Deliverable:** Fully functional wallet with ledger

### Stage 4 – Station Staff – Cash Deposit Flow ✅
- [x] Search endpoint: `GET /staff/customers?phone=`
- [x] Deposit endpoint: `POST /staff/deposits`
- [x] UI: Customer search + cash-deposit modal + confirmation screen
- **Deliverable:** Staff can credit any customer's wallet; audit log records staff ID

### Stage 5 – Fuel Types & Pricing Service ✅
- [x] `GET /fuel-types` (public)
- [x] Admin CRUD: `POST /admin/fuel-types`, `PATCH /admin/fuel-types/:id`, `DELETE /admin/fuel-types/:id`
- [x] UI: Admin Fuel Types table with live price editing
- **Deliverable:** Centralised fuel catalogue; price snapshot on request creation

### Stage 6 – Customer Fuel Request (Create & Reserve) ✅
- [x] `POST /fuel-requests` validates balance, reserves funds, stores price per litre
- [x] Auto-expire pending requests (background job + lazy expiry, race-safe)
- [x] UI: “Request Fuel” page with station/fuel selectors, live cost estimate, balance check, submit button
- **Deliverable:** Request gets a `request_reference`; funds moved to `reserved_balance`

### Stage 7 – Station Portal – Pending Request Management ✅
- [x] `GET /staff/pending-requests`
- [x] `POST /staff/requests/:id/accept` → keep reservation, status = ACCEPTED
- [x] `POST /staff/requests/:id/reject` → release reservation, status = REJECTED
- [x] UI: Pending Requests table with **Accept** / **Reject** actions
- **Deliverable:** Staff can approve/reject; wallet balances adjust correctly

### Stage 8 – Pump Assignment & Authorization Token ✅
- [x] `POST /staff/requests/:id/assign-pump` (stores `pump_id`, holds pump as RESERVED)
- [x] `POST /staff/requests/:id/authorize` creates `fuel_transactions` row with unique
      `transaction_reference` (`FUEL-YYYYMMDD-NNNNNN`, sequential per day, race-safe) and status `AUTHORIZED`
- [x] Pull endpoint for ESP32: `GET /esp32/authorizations/:pump_id` (HMAC-signed payload,
      API-key auth, optional station pinning)
- [x] UI: Assign Pump dropdown + **Assign** button, **Authorize** enabled once assigned
- **Deliverable:** Signed transaction that the ESP32 can fetch

### Stage 9 – ESP32 Firmware (IoT Controller) ✅
- [x] HTTPS client authenticates with a static API key (`x-api-key`)
- [x] Poll `/esp32/authorizations/:pump_id` for an `AUTHORIZED` transaction (signature verified on-device)
- [x] Open relay to power pump; read flow-sensor pulses → litres
- [x] Periodically `POST /esp32/authorizations/:pump_id/status` with `{currentLitres, pumpState}`
- [x] When `currentLitres ≥ authorizedLitres` → close relay, `POST …/completed` with final quantity
- [x] Error status on sensor failure / dispense timeout
- [x] **Python mock** (`esp32-mock/pump_mock.py`) for early integration testing without hardware
- **Deliverable:** Compilable sketch (`esp32-mock/firmware/`) + mock that talks to the server

### Stage 10 – Real-Time Dispensing UI (SSE) ✅
- [x] Server-sent events endpoints `/api/stream/pumps/:pump_id`, `/api/stream/station`, `/api/stream/me`
- [x] `pumpProgress` component (vanilla JS) subscribes and renders a progress bar, current litres, pump ON/OFF indicator
- [x] Used in both customer dashboard and staff fuel desk
- **Deliverable:** Live, animated view of dispensing progress

### Stage 11 – Transaction Finalisation & Receipt Generation ✅
- [x] On completion, backend calculates `final_amount = actual_litres × price_per_litre`
- [x] `FUEL_PAYMENT` wallet transaction; unused reserve released back to `available_balance`
- [x] `fuel_transactions.status = COMPLETED` with timestamps
- [x] PDF receipt (pdfkit) generated on demand, stored link (`receipt_url`), protected download
- [x] UI: Receipt page with **Download PDF** button
- **Deliverable:** Funds settled, receipt downloadable

### Stage 12 – Admin Dashboard & Auditing ✅
- [x] Admin CRUD for stations, pumps, staff (fuel types since Stage 5)
- [x] `GET /audit-logs` with filters (action, entity, date range, user, station)
- [x] UI: Admin Dashboard cards (customers, stations, active pumps, litres/revenue today, recent audits)
- [x] Block/unblock accounts (`status` field, enforced at login)
- **Deliverable:** Full system oversight and immutable audit trail

### Stage 13 – Polish, Security & Testing ✅
- [x] Unit tests for services (wallet ledger, auth) — `npm test` (mocha + self-tests)
- [x] Security hardening: helmet, rate limiting, configurable CORS, `.env` secret management
- [x] UI polish: dark theme, micro-animations, responsive mobile-first layout
- [x] Swagger UI at `/docs` for API inspection
- **Deliverable:** Test-covered, secure, visually polished prototype

### Stage 14 – Deployment & Documentation ✅
- [x] `docker-compose.yml` with `db`, `backend` and optional `esp32-mock` services
- [x] README: prerequisites, one-command start, demo credentials, portal walkthroughs
- [x] OpenAPI spec published via Swagger UI (`/docs`), linked from README
- **Deliverable:** One-click start for reviewers; full documentation

## ESP32 Pump Controller Integration

Configure in `.env`:

```
ESP32_API_KEY="a-long-random-string"     # x-api-key the controller sends; empty = endpoints disabled
DEVICE_SIGNING_SECRET="another-secret"   # HMAC key; defaults to ESP32_API_KEY
DEVICE_STATION_ID="<station uuid>"       # optional pin for single-station controllers
```

Poll loop on the controller:

1. `GET /api/esp32/authorizations/<pump_id>` with header `x-api-key: $ESP32_API_KEY`
   - `authorization: null` → nothing to dispense, keep polling
   - otherwise verify `signature` = HMAC-SHA256(`DEVICE_SIGNING_SECRET`, fields joined by `|`
     in `signature_payload_fields` order) before dispensing a single millilitre
2. Dispense up to `authorized_litres` at `price_per_litre`
3. Report the result: `POST /api/esp32/authorizations/<pump_id>/ack`
   `{ "transaction_id", "actual_litres", "device_signature" }`
   - server settles the wallet (FUEL_PAYMENT for the dispensed amount, RELEASE for the
     unused reserve) and frees the pump
   - `device_signature` is optional but recommended: it proves the ack came from the
     device that received the signed authorization

### Python mock (no hardware needed)

```bash
pip install -r esp32-mock/requirements.txt
python esp32-mock/pump_mock.py --base-url http://localhost:4000 --pump-id <PUMP_UUID> \
  --api-key "$ESP32_API_KEY" --signing-secret "$DEVICE_SIGNING_SECRET"
```

Or run it via Docker alongside the stack: `docker compose --profile mock up`. The mock polls
for authorizations on its pump, verifies the HMAC signature, "dispenses" at a configurable
litres-per-second rate, streams status telemetry, and completes the transaction — driving the
full request → authorize → dispense → settle → receipt loop end to end.

## Testing & Security

```bash
npm test        # mocha unit tests (wallet ledger, auth) + ledger/signature self-tests
npm run lint    # eslint
```

Security posture: bcrypt-only password hashing, JWT access (15 m) + rotating refresh tokens
(7 d, hashed at rest, revoked on logout), role-scoped endpoints, helmet headers, rate-limited
API, constant-time device API-key comparison, HMAC-signed device payloads, receipt URLs with
expiring signed tokens, configurable CORS, and secrets via `.env` (never committed).

## ER Diagram

```mermaid
erDiagram
    USER ||--o| WALLET : has
    USER ||--o{ FUEL_REQUEST : creates
    USER ||--o{ REFRESH_TOKEN : owns
    WALLET ||--o{ WALLET_TRANSACTION : ledger
    STATION ||--o{ PUMP : has
    STATION ||--o{ STATION_USER : staffed_by
    STATION ||--o{ FUEL_REQUEST : serves
    STATION ||--o{ FUEL_TRANSACTION : logs
    FUEL_TYPE ||--o{ PUMP : dispensed_at
    FUEL_TYPE ||--o{ FUEL_REQUEST : priced
    FUEL_REQUEST ||--o| FUEL_TRANSACTION : settled_by
    STATION_USER ||--o{ REFRESH_TOKEN : owns
    STATION_USER ||--o{ AUDIT_LOG : writes

    USER { string id PK  string email UK  string full_name  string status }
    WALLET { string id PK  decimal available_balance  decimal reserved_balance  string currency }
    WALLET_TRANSACTION { string type  decimal amount  decimal balance_before  decimal balance_after  string reference UK }
    FUEL_REQUEST { string request_reference UK  decimal requested_litres  decimal requested_amount  string status }
    FUEL_TRANSACTION { string transaction_reference UK  decimal authorized_litres  decimal actual_litres  decimal final_amount  string status }
    PUMP { int pump_number  string status }
    FUEL_TYPE { string name UK  decimal price_per_litre }
    STATION { string name  string location }
    STATION_USER { string username UK  string role }
    REFRESH_TOKEN { string token_hash UK  datetime expires_at  datetime revoked_at }
    AUDIT_LOG { string action  string entity_type }
```

## License

ISC
