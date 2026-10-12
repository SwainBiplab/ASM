# BPO Asset Management — working notes for Claude Code

**Specification:** `BPO_ASSET_MANAGEMENT_TAS_v2.0.md` is authoritative for all new work (roadmap §22, open decisions §23). `docs/ARCHITECTURE_V2_CLOUD.md` = rationale and migration matrix (§7: what's historical, reusable or to redesign). `BPO_ASSET_MANAGEMENT_TAS_v1.0.md` = historical desktop spec; don't follow it for new features. Prompts: `prompts/`.

**Stack:** React + TypeScript browser UI (`web/`, from W3) · Fastify + plain parameterized SQL (`server/`) · PostgreSQL · S3-compatible storage abstraction · server-side sessions · container + managed PostgreSQL (provider undecided) · one organization (multi-tenant later) · no offline sync (U1 open).

**Prototype:** the Electron/SQLite app in `src/main`, `src/preload`, `src/renderer` is frozen reference code; port from it, don't extend it. `src/shared` is shared by everything.

**Product direction changed (D53): cloud-only, no Electron desktop app.** The W9.3–W9.6 desktop agent (`agent/`, its build/test tooling, and `src/shared/clientApi.ts`) was built and then removed — BPO Asset Management ships as a web application only. The W9.2/W9.7 **server-side** offline-lease and sync infrastructure is retained because it remains part of the product plan: device enrollment/trust/revocation, exclusive leases, asset-code-range scopes (`server/src/services/offlineLeases.ts`, migration `0009_offline_leases.ts`), and gated sync ingestion (`server/src/services/offlineSync.ts`, migration `0010_offline_sync.ts`, `SYNC_UPLOADS_ENABLED`), including the `assertAssetsNotLeased` (C1) write-protection wired into `allocations.ts`/`assets.ts`/`maintenance.ts`/`audits.ts`. The admin UI for devices/leases (`web/src/features/offlineAgents/`) stays — it's a cloud web screen, not desktop code. See `docs/BPO_ASSET_MANAGEMENT_W9_OFFLINE_AGENT_TAS_v1.0.md`/`..._IMPLEMENTATION_PLAN_v1.0.md` (now marked superseded) and DECISIONS.md D48–D53 for history.

## Server conventions
- Services are async functions taking `(db | tx, input, ctx: OpContext)`; `ctx.actor.organizationId` comes from the session and **every query filters by it**.
- Use `db.tx(async (t) => …)` for multi-statement changes and write `recordAudit(t, …)` in the same transaction.
- Add a command: name in `server/src/rpc/commandNames.ts` → definition (input schema, **output schema** in `responses*.ts` typed `z.ZodType<Dto>`, auth, `idempotency`) in `commands.ts`/`commandsW2.ts`; the shared `CommandMap` defines DTOs. Output parsing strips undeclared fields (D34).
- Mutations that must not run twice on retry declare `idempotency: 'required'` (D36); handlers must use `ctx.db` (bound to the idempotent transaction).
- A `get*` read used both as its own command (needs the view permission) and as the tail call inside a write a *different* permission already authorized (e.g. `getHandover`/`getTicket`/`getAudit` returning the result of `create*`/`close*`) takes an `afterWrite = false` param that skips the view-permission check only for the write's own call site. Forgetting this rolls back the write itself, since the read runs inside the same transaction and throws.
- API lives under `/api/v1` (D33). Files go through `server/src/routes/files.ts` (multipart upload, authorized download, export) and `DocumentStorage`. Never accept storage keys or paths from clients (D35).
- Migrations: `server/src/db/migrations/NNNN_*.ts`, append-only, checksummed.
- Server tests: `tests/server/*` against a real ephemeral PostgreSQL (`npm run test:server`; `TEST_DATABASE_URL` overrides). Use `createApiSession()` (`ok/call/upload/get/sql`, auto Idempotency-Key) or `createTestServer()` + `rpc()`.
- Run locally: settings live in a git-ignored `.env` (template `.env.example`, loaded by `server/src/envFile.ts`; real env vars win). Then `npm run web:build && npm run server:migrate && npm run server:bootstrap && npm run server:dev`. Never commit `.env`.

## Web client conventions (`web/`, D37)
- All server access goes through `web/src/api.ts`: `call` (RPC), `uploadFile`, `downloadFile`, `apiUrl`. Never use `fetch` directly in screens, and never store session data in Web Storage.
- No business rules in React; permission checks in the UI only hide controls (the server enforces). Render user data as text (no `dangerouslySetInnerHTML`).
- Unbuilt modules stay as `PendingModule` ("Planned, W4…W7"). Don't present unimplemented operations as working.
- Browser E2E: `npm run test:web-e2e` (`tests/web-e2e/*.spec.ts`, Chromium, real API process + throwaway PostgreSQL; accounts in `tests/web-e2e/accounts.ts`; `sql()` helper for arranging and verifying state). Fixtures are test-only.
- Run locally: see `docs/WEB_CLIENT.md` (`npm run web:dev` with the API on :3000, or `WEB_ROOT=web/dist`).

## Prototype notes (frozen)

## Start of every session
Read `PROJECT_STATUS.md`, the current phase section of `IMPLEMENTATION_PLAN.md`, and the latest `JOURNAL.md` entry; consult TAS v2.0 sections relevant to the phase. Read `DECISIONS.md` and `KNOWN_ISSUES.md` only when relevant. Update all of them at milestone end.

## Layout
- `src/shared/`: the IPC contract (`api.ts`: CommandMap + COMMAND_NAMES), Zod schemas, permission catalog, plain constants (the renderer imports these, not Zod)
- `src/main/`: `database/` (connection, migrator, `migrations/NNNN_*.ts`), `services/` (business rules + audit; `common.ts` helpers), `import/` (CSV decode/parse, employee import sessions, native picker), `backup/`, `ipc/` (dispatcher, command table, electron binding), `app/` (container, env/paths, security, smoke test)
- `src/preload/index.ts`: builds `window.api` from COMMAND_NAMES only
- `src/renderer/src/`: React UI; `features/<module>/`; `components/ui.tsx`; tokens in `styles/app.css`

## Adding a command
Add it to `CommandMap` + `COMMAND_NAMES` → add a schema in `schemas.ts` → implement a service that calls `assertPermission` and `recordAudit` inside its transaction → wire it in `ipc/commands.ts` → add integration tests through `tests/helpers.ts` (real SQLite, no mocks).

## Rules
- Never edit an applied migration; add `NNNN_*.ts` and append it to `migrations/index.ts`.
- Money is integer minor units. Timestamps are UTC ISO strings. IDs are UUIDs.
- Business rules go in services, never in React. Enforce invariants in both the DB and the service.
- The terminal has `ELECTRON_RUN_AS_NODE=1`; use the npm scripts, or strip the variable when launching Electron.
- File input/output always goes through native dialogs in main (`container.pickImportFile`, `pickDocumentFile`, `pickSavePath`, `openPath`; stubbed in tests). Never accept paths from the renderer.
- Money: integer minor units via `parseMoneyToMinor`; cost fields need `finance.view_cost` and never go into audit summaries.
- Asset codes come only from `issueAssetCode` inside the insert transaction; `asset_code` is immutable (DB trigger).
- Verify with: `npm run verify`, `npm run test:e2e`, `npm run package:dir && npm run smoke:packaged`.
