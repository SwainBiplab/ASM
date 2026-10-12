# BPO Asset Management: Architecture v2 (cloud, multi-user)

**Status:** Architecture rationale and migration record (prompt5, 2026-10-11). **The authoritative technical specification is now `BPO_ASSET_MANAGEMENT_TAS_v2.0.md`** (adopted 2026-10-11, DECISIONS D32). This document explains *why* the architecture changed, the trade-offs and the migration decisions; where it and TAS v2.0 differ, TAS v2.0 wins. `BPO_ASSET_MANAGEMENT_TAS_v1.0.md` is the historical desktop-prototype specification.

The Electron/SQLite implementation (commits `5ebaa7b`, `471ea57`, `3e13749`) is retained in `src/` as the **prototype and migration reference**. It is not the production client.

---

## 1. Why the architecture changed

People in IT, HR, Facilities, Procurement, Finance and management must work on **shared, current records from different computers**. A single-computer SQLite database can't provide that without a central server, so Version 1 becomes a central web application:

| Layer | v1 (prototype) | v2 (target) |
|---|---|---|
| Client | Electron renderer | React + TypeScript SPA in the browser (desktop and compatible mobile browsers) |
| Application logic | Electron main process | Central Node.js API (Fastify) |
| Data | SQLite file per computer | PostgreSQL (single authoritative database) |
| Documents | Local `documents/` folder | `DocumentStorage` abstraction: S3-compatible object storage in production, controlled local folder in development |
| Auth | Local accounts, in-memory session | Central accounts, server-side sessions in PostgreSQL, secure cookies |
| Backup | App-managed file copies | Managed PostgreSQL backups + PITR, object-storage versioning; app-level backup screen retired |
| Tenancy | Single organization | Single organization deployed; `organization_id` ownership on every root table, enforced by the server |

## 2. Offline requirement conflict (must not be silently ignored)

The TAS required almost all operations to work offline. A cloud-first system can't do that **and** guarantee no conflicting assignments without a synchronization design.

| Option | Consequence |
|---|---|
| A. Online-only transactions (**provisional decision**) | Simple, consistent and auditable; the server is the single source of truth. Users need connectivity to issue, transfer, return, approve or clear. |
| B. Offline transactions with later sync | Requires local stores, operation IDs, idempotency, conflict resolution (two people issuing one asset offline) and "pending vs confirmed" UX. Large effort and risk. TAS §18 already flags it as future work. |

**Provisional policy for Version 1:**
- Allocation, transfer, return, acknowledgment, approvals, exit clearance and all other state-changing business transactions **require a live connection** to the API. The client shows a clear offline state and blocks submission.
- Read-only cached views and local *drafts* (unsent form data) may be added later as a separate, explicitly labelled feature. Cached data is never presented as current.
- No offline transaction synchronization is built.
- **Open business decision (U1):** confirm whether any workflow must truly work offline (for example a physical audit on a floor with no network). If yes, it gets a dedicated design before implementation.

## 3. Backend selection

Two options compared (verified against npm, 2026-10-11):

| Criterion | **Fastify 5 + node-postgres (`pg`) + SQL migrations** (selected) | NestJS 12 + Prisma 7/8 |
|---|---|---|
| Fit with existing code | Existing services are plain TypeScript functions with Zod and hand-written SQL. They port almost one-to-one (sync → async, `?` → `$n`). The dispatcher and command contract are reused unchanged. | Requires re-shaping services into Nest modules/providers/decorators and rewriting every query in the Prisma client API. |
| TypeScript | Native; Fastify types; Zod schemas reused. | Native; decorators and DI add indirection. |
| PostgreSQL features | Full SQL: partial unique indexes, `SELECT … FOR UPDATE`, CHECKs, triggers, recursive CTEs (all already used). | Prisma schema can't express partial indexes, triggers or CHECKs; those need raw SQL migrations alongside. |
| Migrations | Versioned `.sql` files with the existing checksum runner (ported). Every statement is reviewable. | Prisma Migrate (generated SQL plus engine binaries); the next major (`8.0.0-rc`) was still pre-release and requires Node ≥ 22.18. |
| Transactions | Explicit `withTransaction(fn)` on one pooled client; isolation level per call. | Interactive transactions supported; extra limits and timeouts to manage. |
| Auth/RBAC | The existing session plus permission model ports directly; `@fastify/cookie`, `@fastify/rate-limit`, `@fastify/helmet`. | Guards/Passport; equivalent but new code. |
| Testing | Same Vitest setup; real PostgreSQL per test file (ephemeral cluster). | Similar, plus Nest testing module boilerplate. |
| Deployment | One Node process (API + static SPA), one container image. | Same, but larger dependency surface. |
| Dependencies | ~10 small, actively maintained packages. | Larger framework + ORM engine. |

**Decision:** Fastify + `pg` + checksummed SQL migrations + Zod. No ORM; a small typed query helper (`db.one/many/exec`) keeps SQL explicit, as in the prototype. Revisit an ORM or query builder only if the query volume makes hand-written SQL error-prone.

## 4. Target structure

```
src/shared/          # reused as-is: command contract, Zod schemas, permissions, constants (no Node/DOM deps)
src/main/, src/preload/, src/renderer/   # Electron prototype (frozen reference)
server/src/
  app.ts             # Fastify app factory (testable without listening)
  config.ts          # env-based configuration, validated with Zod
  db/                # pg pool, withTransaction, migration runner, migrations/NNNN_*.sql
  auth/              # password hashing (scrypt), sessions, rate limiting
  rpc/               # HTTP binding of the existing dispatcher (POST /api/rpc/:command)
  services/          # domain services (async ports of src/main/services)
  storage/           # DocumentStorage interface: local + S3 drivers
  routes/            # non-RPC routes: health, uploads, downloads
web/src/             # Vite SPA reusing renderer components; fetch-based API client
tests/server/        # PostgreSQL integration + API authorization tests
tests/web-e2e/       # Playwright browser tests
```

### API style
The typed command contract (`CommandMap`) stays. Each command is exposed as `POST /api/rpc/<group.method>` with a JSON body. The server validates with the same Zod schema, resolves the session from the cookie, checks permissions in the service and returns the same `Result` envelope. That lets the React UI and the tests reuse their call sites (only the transport changes). Binary transfers use dedicated routes:
- `POST /api/uploads/import-csv` and `POST /api/uploads/document` (multipart, size-limited, streamed to storage)
- `GET /api/documents/:id/content` (authorized, `Content-Disposition`, checksum-verified)
- `GET /api/exports/assets.csv` (authorized, audited)
- `GET /api/health/live`, `GET /api/health/ready`

## 5. Security and data architecture

| Area | Design |
|---|---|
| Accounts | `users` per organization; usernames unique per organization; scrypt hashes (ported); admin-created accounts with forced password change. |
| Sessions | Random 256-bit session ID; only its SHA-256 is stored in `sessions` (user, organization, created, last-seen, idle and absolute expiry, IP/user-agent hash, revoked_at). Cookie `__Host-bpoam_sid`: `HttpOnly; Secure; SameSite=Lax; Path=/`. Idle timeout (setting) + absolute lifetime (12 h default). Logout, password change, deactivation and role change revoke sessions server-side. |
| Account recovery | Provisional: an administrator reset (one-time temporary password, forced change) plus revocation of all sessions. Self-service email recovery needs SMTP and an email-ownership policy (**open decision U2**). |
| Rate limiting | Per-IP and per-username login throttling (`@fastify/rate-limit` + the existing per-account lockout); global API limit; stricter limits on uploads and exports. |
| CSRF | SameSite cookies + mandatory custom header (`X-BPOAM-Request: 1`) on all state-changing requests + `Origin` check against the configured public origin. |
| Authorization | Every RPC passes through the dispatcher: Zod validation → session → permission checks inside services (unchanged rule: hiding a button is not authorization). |
| Organization boundary | Every root table has `organization_id`. The session carries the organization ID and every query filters by it (helper-enforced), so the renderer never chooses an organization. Composite foreign keys or checks keep children inside the parent's organization. Tests assert cross-organization access is denied even with valid IDs. |
| Validation | Zod at the API edge (shared schemas) + PostgreSQL constraints (CHECK, FK, unique and partial unique indexes). |
| Conflicting assignments | Partial unique index `UNIQUE (asset_id) WHERE status = 'active'` + `SELECT … FOR UPDATE` on the asset row inside the transaction; a unique violation maps to `STATE_CONFLICT`. Tested with truly concurrent connections. |
| Sequences | Asset codes and document numbers use a row lock (`SELECT … FOR UPDATE`) on the counter row inside the business transaction, so codes stay gap-free and never reused. |
| Audit | `audit_events` append-only (trigger), written in the same transaction; includes IP and correlation ID; personal values and costs redacted as in the prototype. |
| Attachments | Upload size and type allow-list + magic bytes (ported); generated keys; SHA-256; stored via `DocumentStorage`; downloads only through the authorized route (no public bucket URLs); optional malware scanning hook (**U3**). |
| Transport and headers | HTTPS only (TLS at the load balancer or proxy); HSTS; `@fastify/helmet` CSP (`default-src 'self'`, no inline script), `frame-ancestors 'none'`, `nosniff`. |
| Secrets | Environment variables only (`DATABASE_URL`, `SESSION_SECRET`, S3 credentials), injected by the platform secret store; never in the repo; config validated at boot. |
| Errors and logging | Stable error codes with correlation IDs; no stack traces to clients; structured JSON logs to stdout (platform log collection); redaction of secrets and personal fields. |
| Backup and recovery | Managed PostgreSQL automated backups + point-in-time recovery; object-storage versioning and lifecycle rules; documented restore drill. In-app backup/restore screens are retired. |

## 6. Hosting and deployment (provider-neutral)

- **One container image:** Node 24 LTS running the Fastify API, which also serves the built SPA.
- **Managed PostgreSQL** (any provider: Azure Database for PostgreSQL, AWS RDS, GCP Cloud SQL, or self-hosted).
- **Object storage**, S3 API (AWS S3, MinIO, Cloudflare R2, etc.). An Azure Blob driver can implement the same `DocumentStorage` interface if Azure is chosen.
- TLS-terminating load balancer or reverse proxy; 1–2 app instances (the app is stateless: sessions in PostgreSQL, files in object storage).
- Local and dev environments: `docker compose` with PostgreSQL + MinIO, or the local storage driver.
- Not used (not justified at 500–2,000 employees): Kubernetes, microservices, message brokers, Redis.
- **Open decision U4:** cloud provider and region (data-residency requirements for employee data).

## 7. Migration matrix (M1–M3 → v2)

Legend: **1** reusable with minor changes · **2** reusable domain logic with a new persistence layer · **3** redesign · **4** not needed in web V1.

| Area | Prototype location | Class | Disposition / dependencies |
|---|---|---|---|
| Command contract, DTOs, Zod schemas, permission catalog, role templates, constants (`src/shared/*`) | shared | **1** | Reused directly by server and web. Remove Electron-only fields (data paths in `SystemInfo`). |
| Dispatcher (validation, auth modes, error mapping) | `src/main/ipc/dispatcher.ts` | **1** | Reused; HTTP binding replaces the IPC binding; error mapping adds PostgreSQL error codes (`23505` → DUPLICATE_RECORD, `23P01`/`40001` → STATE_CONFLICT). |
| IPC sender validation, preload bridge, `app://` protocol, Electron fuses | `src/main/app/security.ts`, `src/preload` | **4** | Replaced by HTTP security (cookie, CSRF header, Origin check, CSP via helmet). |
| First-run setup | `services/setup.ts` | **2** | Becomes a one-time CLI or bootstrap endpoint guarded by a setup token (not open to the internet). |
| Authentication (scrypt, lockout) | `auth/password.ts`, `services/auth.ts` | **2** | Hashing reused. In-memory `SessionManager` → `sessions` table (**3** for sessions). Lock screen becomes idle expiry. |
| Users, roles, permissions | `services/users.ts` | **2** | Async port; invariants kept (last Super Admin, no self-deactivation); session revocation on change. |
| Audit log | `services/audit.ts` | **2** | Async port; append-only trigger in PostgreSQL; adds IP address. |
| Settings | `services/settings.ts` | **2** | Per-organization rows. |
| Departments, teams, locations, workstations, pools | `services/organization.ts` | **2** | Async port; recursive CTE paths work in PostgreSQL. |
| Employees | `services/employees.ts` | **2** | Async port. |
| CSV employee import | `import/csv.ts`, `import/employeeImport.ts` | **1/2** | Parsing and validation reused unchanged; the file arrives by multipart upload instead of a native dialog; import sessions move from memory to a DB table (multi-instance safe). |
| Asset catalogue, assets, lifecycle, codes | `services/catalog.ts`, `services/assets.ts` | **2** | Async port; code issue via a row lock; serial-key unique index unchanged. |
| Documents | `services/documents.ts` | **2/3** | Validation reused; storage behind `DocumentStorage` (local / S3); open and save-copy become an authorized download. |
| QR/barcode labels | `services/labels.ts` (bwip-js) | **1** | Server-side SVG generation unchanged; printing via the browser print dialog. |
| USB scanning, manual lookup | `ScanPage`, `services/assets.ts lookupAsset` | **1** | Keyboard-wedge scanners work in browsers unchanged. Phone camera scanning becomes more feasible (HTTPS origin + `getUserMedia`), still behind U5. |
| Search, filters, exports | `services/assets.ts` | **2** | Export becomes an authenticated `GET` download (`toCsv` reused). |
| Dashboard | `services/dashboard.ts` | **2** | Async port. |
| Backup and recovery screens | `backup/backupService.ts` | **4** | Replaced by managed database backups + PITR and storage versioning (operational runbook). Only the backup manifest and checksum ideas carry into the SQLite→PostgreSQL migration tool. |
| Startup recovery screen, `.initialized` marker | `database/manager.ts` | **4** | Replaced by readiness checks and migration safety in deployment. |
| Migrations runner | `database/migrator.ts` | **1** | Same checksum and history model on PostgreSQL (advisory lock to prevent concurrent runs). |
| React screens and components | `src/renderer/src` | **1** | Reused. `window.api` → HTTP client with the same `call()` signature; native dialogs → `<input type=file>` uploads and download links; the lock screen becomes a session-expiry page. |
| Demo seeder | `app/demoSeed.ts` | **2** | Async port; refuses to run unless `APP_ENV=development`. |
| Packaged smoke test, Electron e2e | `app/smoke.ts`, `tests/e2e` | **3** | Replaced by API smoke tests and Playwright browser e2e. |
| M4 partial work (branch `wip/m4-standalone-sqlite`) | migration 0004 + shared types | **2** | Shared allocation constants and schemas ported; SQL schema re-expressed for PostgreSQL. |

## 8. Data migration plan (SQLite prototype → PostgreSQL)

Implemented as a CLI (`npm run migrate:sqlite -- --source <file> [--apply]`). It reads the SQLite file **read-only**.

1. **Pre-checks:** the source opens read-only; `integrity_check` and `foreign_key_check` pass; the schema version is known; the target database is empty except migrations (refuses otherwise); the organization count is 1.
2. **Demo-data guard:** refuses if the source contains seeded demo markers (organization "Demo BPO Services…", users `assetmgr`/`ittech`…) unless `--allow-demo` is given, and never in production configuration.
3. **Dry run (default):** maps every row to the PostgreSQL schema in memory, preserving UUID primary keys, asset codes, employee codes, timestamps, audit rows and document metadata. It writes a validation report (counts per table, FK resolution, invariant checks: unique codes, one active assignment per asset, serial-key uniqueness, audit append-only ordering) with **no writes**.
4. **Apply:** a single PostgreSQL transaction inserts in dependency order with triggers active (history isn't rewritten: audit rows are inserted as-is, and asset-code counters are set to max+1). Documents are copied from the source `documents/` folder into `DocumentStorage`, verifying SHA-256 against metadata. Any mismatch aborts.
5. **Post-verification:** re-counts and compares with the dry-run report; spot-checks of random records; FK and constraint validation queries.
6. **Rollback:** the source is never modified. On failure the transaction rolls back. After a successful apply, rollback means restoring the pre-migration PostgreSQL snapshot (taken automatically before apply) or dropping and recreating the empty target.
7. **Protection:** reports contain counts and IDs, not personal fields. Temporary files are written to an OS temp directory with restrictive permissions and deleted after the run. Migration requires an explicit `--apply` and a typed confirmation.

## 9. Phased plan

The authoritative roadmap is **TAS v2.0 §22** (W0–W8); status lives in `IMPLEMENTATION_PLAN.md` and `PROJECT_STATUS.md`. TAS v2.0 places the SQLite → PostgreSQL migration (§8 above) in the W8 pilot, and deployment packaging, S3 verification and recovery drills in W8. This replaces the W5/W6 numbering used in the first draft of this file (see D32).

## 10. Open decisions

The authoritative list with provisional defaults and "required before" gates is **TAS v2.0 §23** (U1–U6 technical/product, F1 finance, B1–B7 business). This document doesn't duplicate it. As at adoption, none of U1–U6 is resolved; their provisional defaults apply.
