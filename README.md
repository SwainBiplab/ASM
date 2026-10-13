# BPO Asset Management System

> **Full-lifecycle asset management** for BPO organizations — track IT equipment and facilities assets from procurement through disposal, with allocation, maintenance, audits, and financial reporting.

---

## Overview

A web-based asset management platform built for a BPO with ~500–2,000 employees and one office location (Office No-515). The system manages **563+ assets** across IT hardware and facilities, covering the complete asset lifecycle: procurement → receipt → storage → allocation → maintenance → audits → disposal.

The architecture runs as a **Fastify API + React SPA** served same-origin from a single Node.js process, backed by PostgreSQL and S3-compatible document storage. An optional **offline desktop agent** (Electron + SQLite) allows field staff to browse and record observations without an internet connection.

---

## Tech Stack

| Layer | Technology |
|---|---|
| **API Server** | Node.js 22, Fastify 5, TypeScript |
| **Web Frontend** | React 19, Vite 7, Vanilla CSS (neumorphism design) |
| **Database** | PostgreSQL 18 |
| **Document Storage** | S3-compatible (Adobe S3Mock for local/staging — see note below, any AWS S3-compatible in production) |
| **Desktop Agent** | Electron 44, SQLite (offline-first, read + local observations) |
| **Schema Migrations** | Custom forward-only TypeScript migrator |
| **Testing** | Vitest (unit + server), Playwright (E2E browser) |
| **Containerization** | Docker + Docker Compose |

---

## Features

### 📦 Asset Register
- Individual tracking with unique asset codes (`AST-000001` format), QR codes, and barcode labels
- Categories and models with IT / Facilities domain split
- Bulk-tracked item types for low-value consumables
- Full lifecycle: `new → ready → assigned → under_maintenance → awaiting_inspection → retired / disposed / lost`
- Search, filters, CSV export, and printable label sheets

### 🔄 Allocation & Custody
- Issue to employees, workstations, departments, or shared pools
- Transfers, returns, and inspection workflows
- Configurable handover acknowledgment (in-app or signed receipt upload)
- Employee exit clearance with per-item return tracking and exception approval
- Complete custody movement history per asset

### 🛠️ Maintenance
- Maintenance ticket creation with priority and category
- Technician assignment, work-in-progress evidence uploads
- Resolution → return-to-service decision (ready / awaiting inspection / non-operational)
- Duplicate-ticket guard with an authorized override path
- Maintenance cost tracking and expenditure reporting

### 📋 Physical Audits
- Scope by location, category, custodian, or selected assets
- Frozen baseline (immune to master-data edits after the audit opens)
- Scan-and-confirm observation flow (USB scanner or manual input)
- Automatic discrepancy classification: location / condition / identification / unexpected
- Missing-item flagging and formal exception acceptance

### 🛒 Procurement
- Purchase requests with configurable multi-step approval policies (role-based or named user)
- Purchase orders with line-item amendments (audited reason trail)
- Goods receipt: partial receipts, damaged/rejected quantities, discrepancy resolution
- Automatic asset registration from accepted receipt units
- Bulk stock balance tracking for quantity-tracked item types

### 📊 Dashboard & Reports
- **Interactive dashboard** with neumorphic KPI cards, donut status chart, category bar chart, IT/Facilities domain split
- **5 report families:** asset valuation, maintenance expenditure, procurement & receiving, warranty & lifecycle, disposals & proceeds
- Currency-grouped financial totals (never cross-currency sums)
- `finance.view_cost` permission gate — cost columns are `null` end-to-end for unauthorized viewers
- CSV export with formula-injection protection

### 🔒 Security & Compliance
- Session cookies (HttpOnly, CSRF-protected) — nothing in Web Storage
- Role-based permissions enforced server-side on every command
- Idempotency keys on all mutations (24h TTL, database-backed)
- Append-only audit log with structured event records
- Magic-byte document validation (PDF / images only, 20 MB limit)
- Rate limiting, Helmet headers, input validation via Zod

### 📡 Offline Desktop Agent *(W9, server API complete)*
- Electron shell with context isolation, sandboxed renderer, narrow preload IPC
- Exclusive lease system: field agent holds a work-package scope, online writes to those assets are blocked
- Asset-scoped read-only snapshot downloaded from the server
- Local audit observations (`verifyItem` / `flagMissing`) and maintenance requests stored in SQLite
- Sync upload endpoints (gated off by default pending two open decisions — see `KNOWN_ISSUES.md`)

---

## Quick Start

### Prerequisites
- **Node.js 22+** and **npm**
- **PostgreSQL 18** running locally
- A database named `bpoam` accessible at `postgres://postgres:postgres@127.0.0.1:5432/bpoam`

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env — set DATABASE_URL and PUBLIC_ORIGIN
```

### 3. Run database migrations
```bash
npm run server:migrate
```

### 4. Bootstrap the first organization and admin user
```bash
npm run server:bootstrap
```

### 5. Start the API server
```bash
npm run server:dev
```

### 6. Start the web frontend (separate terminal, for hot-reload dev)
```bash
npm run web:dev
# Opens at http://localhost:5173
```

Or build the frontend and serve everything from the API (same-origin mode):
```bash
npm run web:build
# Then server:dev serves http://127.0.0.1:3000
```

---

## Running with Docker

The full stack (app + PostgreSQL + S3-compatible storage + a TLS-terminating reverse proxy) runs with a single command:

```bash
docker compose up -d --build
```

| Service | What it is | URL / address |
|---|---|---|
| `app` | Web App + API | http://localhost:3000 |
| `proxy` | Caddy, TLS-terminating reverse proxy in front of `app` | https://localhost |
| `postgres` | PostgreSQL 18 | localhost:5432 |
| `s3mock` | S3-compatible document storage (see note below) | localhost:9000 |

> The app automatically runs migrations on first start (`MIGRATE_ON_START=true`).
> `server:bootstrap` is interactive (it asks *you* for the first admin's username/password), so it isn't run automatically — after the stack is up, run it yourself in a real terminal:
> ```bash
> docker compose exec app npx tsx --tsconfig tsconfig.server.json server/src/cli/admin.ts bootstrap
> ```

**Pick one entry point and make `PUBLIC_ORIGIN` in `docker-compose.yml` match it exactly** — the server rejects any request whose browser `Origin` header doesn't match `PUBLIC_ORIGIN` byte-for-byte (CSRF protection), so `http://localhost:3000` and `http://127.0.0.1:3000` are treated as different origins even though they're the same machine.
- **Plain HTTP (default, simplest for local dev):** browse `http://localhost:3000`; `PUBLIC_ORIGIN` is already set to match.
- **Through the TLS proxy** (exercises the real reverse-proxy path): browse `https://localhost` and change `PUBLIC_ORIGIN` to `https://localhost`. Caddy issues its own locally-trusted certificate (`tls internal` in `Caddyfile`) since there's no public domain in local dev — your browser will warn about it once; click through, or use `curl -k`.

> **Object storage note:** MinIO pulled its Docker Hub and Quay images behind a login wall in its 2025 licensing change, so `docker-compose.yml` uses [Adobe's S3Mock](https://github.com/adobe/S3Mock) instead — a real, actively maintained, freely pullable S3-API-compatible server. It's **in-memory**: uploaded documents do not survive restarting the `s3mock` container. Fine for exercising the stack locally; not a substitute for a real S3-compatible provider in staging or production.

> **PostgreSQL 18 volume layout:** the `postgres` service mounts its volume at `/var/lib/postgresql` (not `.../data`) — the 18+ images store data under a version-specific subdirectory and refuse to start against the older mount convention.

### Deploy to another machine

```bash
# Build and export the image
docker build -t bpoam:latest .
docker save bpoam:latest -o bpoam-image.tar

# On the target machine
docker load -i bpoam-image.tar
docker compose up -d   # needs docker-compose.yml and Caddyfile alongside the tar
```

---

## Project Structure

```
ASM/
├── server/                 # Fastify API (TypeScript)
│   └── src/
│       ├── services/       # Business logic (assets, allocations, maintenance…)
│       ├── db/             # PostgreSQL client, migrations (0001–0009)
│       ├── routes/         # HTTP route registration
│       ├── rpc/            # Typed RPC dispatcher
│       ├── storage/        # Document storage (local + S3)
│       ├── auth/           # Session, CSRF, permissions
│       ├── migration/      # Legacy SQLite → PostgreSQL migration tool
│       └── cli/            # Admin CLI (migrate, bootstrap, migrate-legacy)
│
├── web/                    # React SPA (Vite)
│   └── src/
│       ├── features/       # One folder per module (dashboard, assets, allocations…)
│       ├── components/ui/  # Shared UI primitives
│       ├── styles/app.css  # Full design system (neumorphism tokens + components)
│       └── api.ts          # Typed HTTP client with CSRF + idempotency
│
├── agent/                  # Electron offline agent
│   ├── main/               # Main process: SQLite, IPC handlers, cloud client
│   ├── preload/            # Narrow sandboxed IPC bridge
│   └── renderer-src/       # React renderer (imports from web/src directly)
│
├── src/shared/             # Shared TypeScript types, Zod schemas, permissions
├── docs/                   # Architecture, backup/recovery, pilot plan, W9 TAS
├── tests/                  # Playwright E2E (web-e2e/) + agent unit tests
├── scripts/                # Build scripts, seed, import utilities
├── Dockerfile              # Multi-stage: build web → runtime Node image
├── docker-compose.yml      # Full stack: app + PostgreSQL + S3Mock + Caddy TLS proxy
└── Caddyfile               # TLS-terminating reverse proxy config for the `proxy` service
```

---

## Available Scripts

| Command | Description |
|---|---|
| `npm run server:dev` | Start API server with hot-reload |
| `npm run server:migrate` | Run pending database migrations |
| `npm run server:bootstrap` | Create first organization + admin user |
| `npm run server:migrate-legacy` | Migrate data from the old SQLite prototype |
| `npm run web:dev` | Start React dev server (port 5173) |
| `npm run web:build` | Build the production React bundle |
| `npm run agent:dev` | Build and launch the Electron offline agent |
| `npm test` | Run all unit tests (Vitest) |
| `npm run test:server` | Run server-only tests against ephemeral PostgreSQL |
| `npm run test:web-e2e` | Run Playwright E2E tests (builds frontend first) |
| `npm run typecheck` | TypeScript type-check all 6 projects |
| `npm run seed:demo` | Insert demonstration/dummy data |

---

## Test Coverage (as of W9)

| Suite | Tests | Scope |
|---|---|---|
| Server (Vitest + real PostgreSQL) | **134/134** | All API services, concurrency, idempotency, security |
| Browser E2E (Playwright + Chromium) | **54/54** | All web screens against real API process |
| Agent unit (Vitest + real SQLite) | **39/39** | Dispatcher, repositories, offline sync |
| Prototype Electron E2E | **8/8** | Regression |

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `PUBLIC_ORIGIN` | ✅ | Base URL shown in browser — must match exactly (CSRF check) |
| `WEB_ROOT` | | Path to built `web/dist` (omit for live-reload mode) |
| `APP_ENV` | | `development` or `production` |
| `HOST` | | Bind address (default `127.0.0.1`) |
| `PORT` | | Listen port (default `3000`) |
| `MIGRATE_ON_START` | | `true` to auto-migrate on boot (used in Docker) |
| `STORAGE_DRIVER` | | `local` (default) or `s3` |
| `STORAGE_LOCAL_ROOT` | | Local document storage path (when `STORAGE_DRIVER=local`) |
| `STORAGE_S3_BUCKET` | | S3 bucket name (when `STORAGE_DRIVER=s3`) |
| `STORAGE_S3_REGION` | | S3 region |
| `STORAGE_S3_ENDPOINT` | | S3 endpoint URL (for non-AWS providers, e.g. the `s3mock` service in Docker) |
| `STORAGE_S3_ACCESS_KEY_ID` | | S3 access key (S3Mock accepts any value) |
| `STORAGE_S3_SECRET_ACCESS_KEY` | | S3 secret key (S3Mock accepts any value) |
| `STORAGE_S3_FORCE_PATH_STYLE` | | `true` for S3Mock, MinIO, and most non-AWS providers |
| `SYNC_UPLOADS_ENABLED` | | `true` to enable offline-agent sync upload endpoints (gated off by default) |

---

## User Roles

| Role | Key capabilities |
|---|---|
| **Super Admin** | Full system access, user management, settings |
| **Asset Manager** | Full asset lifecycle, allocations, audits, reports |
| **IT Technician** | Maintenance tickets, asset inspection, offline agent |
| **Facilities Manager** | Facilities assets, maintenance, audits |
| **Procurement Officer** | Purchase requests, purchase orders, goods receipt |
| **Finance Viewer** | All reports including cost/financial columns |
| **HR** | Employee records, exit clearances |
| **Viewer** | Read-only access |

---

## Open Decisions / Known Limitations

- **W-44:** Fencing epoch not restore-safe — sync uploads are gated off until resolved
- **W-45:** Device trust not formally accepted — sync uploads gated pending this decision
- **U2:** No self-service password recovery (admin-only reset)
- **U3:** No malware scanner (restricted upload posture documented)
- **U4:** Cloud provider not selected
- **B7:** No email delivery capability
- **F1:** Depreciation policy not approved by Finance (`DEPRECIATION_ENABLED = false`)

See [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md) and [`DECISIONS.md`](DECISIONS.md) for full detail and disposition of each item.

---

## Documentation

| File | Content |
|---|---|
| [`BPO_ASSET_MANAGEMENT_TAS_v2.0.md`](BPO_ASSET_MANAGEMENT_TAS_v2.0.md) | Authoritative technical architecture specification |
| [`DECISIONS.md`](DECISIONS.md) | All architectural and business decisions with rationale |
| [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md) | Open issues, blockers, and workarounds |
| [`PROJECT_STATUS.md`](PROJECT_STATUS.md) | Sprint-by-sprint delivery log (W1–W9) |
| [`docs/BACKUP_RECOVERY.md`](docs/BACKUP_RECOVERY.md) | pg_dump/restore procedures and RPO/RTO targets |
| [`docs/PILOT_PLAN.md`](docs/PILOT_PLAN.md) | Six-stage go-live plan with rollback criteria |
| [`docs/WEB_CLIENT.md`](docs/WEB_CLIENT.md) | Screen → API map, run instructions |

---

## License

Private — proprietary BPO project. Not licensed for redistribution.
