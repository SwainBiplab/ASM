# Web client (W3)

The browser application lives in `web/`. It was ported from the frozen Electron renderer (`src/renderer`); the prototype is unchanged and still builds. Decisions: D37 (client) and D38 (browser E2E).

## Runtime model
- **Same origin.** In test and production, the API serves the built files (`WEB_ROOT=web/dist`, `@fastify/static`). Cookies, the CSRF Origin check and the CSP `'self'` sources therefore apply unchanged, and no CORS is configured. In development, `npm run web:dev` (Vite on :5173) proxies `/api` to the API on :3000, with `PUBLIC_ORIGIN=http://localhost:5173` set on the API.
- **Session.** The HttpOnly, SameSite=Lax cookie set by `session.login`. The client never sees the token, and nothing session-related goes into Web Storage. A reload calls `session.getCurrent` to restore the session.
- **Expiry.** The server owns idle and absolute expiry. The client sends `session.touch` at most once a minute while the user is active, and polls `session.getCurrent` every 30 s and when the tab becomes visible. Any `NOT_AUTHENTICATED` response returns the user to sign-in with an explanation.
- **Client** (`web/src/api.ts`):
  - `call(command, input)` → `POST /api/v1/rpc/<command>`, with `x-bpoam-request: 1` and `Idempotency-Key` on non-read commands.
  - `uploadFile` → multipart upload.
  - `downloadFile` → fetches into a Blob, so errors still arrive as the JSON envelope.
  - `apiUrl` → builds the URLs for authorized GETs.
  - `ApiError` carries `code`, `correlationId`, `fieldErrors` and `status`. Network failures become `NETWORK_ERROR`.
  - `assets.create`, `employees.importCommit` and document uploads are retried once **with the same key** after a dropped connection, and the server replays the result (D36).
- **Routing.** Hash routes (`#/assets/<id>`), so any static host works and no server fallback route is needed.
- **Configuration.** `VITE_API_BASE` (optional, build-time, not a secret) sets an API origin. The default is the same origin.

## Screen → API mapping
| Screen | Reads | Writes / files |
|---|---|---|
| Start-up | `system.getStartupState`, `session.getCurrent` | — (setup is the bootstrap CLI; the page only tells the admin) |
| Sign-in / password change | — | `session.login`, `session.changePassword`, `session.logout`, `session.touch` |
| Dashboard | `dashboard.getSummary` | — |
| Departments and locations | `departments/teams/locations/workstations/pools.list`, `employees.search` (pickers) | `*.create`, `*.update`, `*.setActive` |
| Employees | `employees.search`, `employees.get`, `departments/teams/locations.list` | `employees.create/update/deactivate/reactivate` |
| Employee CSV import | `employees.importPreview` (remap) | `POST /api/v1/uploads/employee-import` (preview), `employees.importCommit`, `employees.importCancel` |
| Asset catalogue | `categories/models/suppliers.list` | `*.create`, `*.update`, `*.setActive` |
| Assets | `assets.search`, `assets.get`, lookups | `assets.create/update/changeLifecycle`, `documents.removeLink` |
| Asset documents | `assets.get` (`documents[]`, incl. `scanStatus`) | `POST /api/v1/uploads/documents`, `GET /api/v1/documents/:id/content` |
| Labels | `assets.generateLabels` (SVG data URLs) | browser print dialog |
| Scan / find | `assets.lookup`, `settings.get` (scanner suffix) | — |
| CSV export | — | `GET /api/v1/exports/assets.csv?<filters>` |
| Users and roles | `users.list`, `roles.list` | `users.create/update/resetPassword`, `roles.updatePermissions` |
| Audit log | `audit.list` | — |
| Settings | `settings.get`, `assets.getCodeConfig` | `settings.update`, `assets.updateCodeConfig` |
| Allocations, exit clearance, maintenance, procurement, approvals, audits, finance, reports | — | Marked **Planned (W4–W7)**; no functionality |

Removed from the web path (desktop-only): the lock screen (idle expiry signs the user out), the setup wizard, backup/restore, the startup recovery screen (replaced by "service unavailable"), native file dialogs, and the system-info panel.

## Running locally (development)
Settings come from a git-ignored `.env` file in the project root. Copy `.env.example` to `.env` and set `DATABASE_URL`, `PUBLIC_ORIGIN` and `WEB_ROOT`. The server and the admin CLI load it at start-up; real environment variables override it, and `ENV_FILE` points to another file.

**Same origin (as tested):**
1. `npm run web:build`
2. `npm run server:migrate`
3. `npm run server:bootstrap` (once: creates the organization and the first Super Admin)
4. `npm run server:dev`
5. Open the `PUBLIC_ORIGIN` address (default http://127.0.0.1:3000).

**Live reload:** in `.env`, set `PUBLIC_ORIGIN=http://localhost:5173` and comment out `WEB_ROOT`. Run `npm run server:dev`, then in a second shell run `npm run web:dev` and open http://localhost:5173.
