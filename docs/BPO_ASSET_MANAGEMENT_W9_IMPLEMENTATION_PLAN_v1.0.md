# BPO Asset Management System
## W9 Offline Desktop Agent — Implementation Plan v1.0

**Status: SUPERSEDED (DECISIONS.md D53/D54).** The product direction changed to cloud-only; the desktop agent this plan describes (W9.3–W9.6) was built and has since been removed (D53). W9.2's server-side device/lease foundation and W9.7's gated sync ingestion were initially retained but have since been removed entirely too (D54). This document is kept as historical design record only — nothing it describes exists in the codebase today.  
**Depends on:** Cloud W0–W8 implementation; verify actual repository/commit state before execution  
**Primary specification:** `BPO_ASSET_MANAGEMENT_W9_OFFLINE_AGENT_TAS_v1.0.md`  
**Parent specification:** `BPO_ASSET_MANAGEMENT_TAS_v2.0.md`

---

## 1. Goal

Add an Electron + React + TypeScript Windows desktop agent with local SQLite, a transactional outbox, and controlled offline operation while preserving the current browser application, Fastify API, PostgreSQL database, object storage, and W0–W8 history.

Offline mutation is authorized only by server-issued exclusive work packages/leases. The server remains authoritative and does not automatically free an expired scope while unsynchronized operations may exist.

## 2. Scope discipline

### In scope

- offline capability and threat-model specification;
- device enrollment and revocation;
- server-side lease/work-package management;
- local client storage and synchronization foundations;
- operation receipts, idempotency, fencing and conflict handling;
- per-workflow rollout of offline capabilities;
- recovery and pilot documentation.

### Out of scope for the first W9 increment

- replacing the cloud web application;
- making PostgreSQL or S3 dependent on the desktop agent;
- unrestricted offline writes to every entity;
- automatic last-write-wins merge;
- offline user/role/policy administration;
- multi-tenant SaaS provisioning/billing;
- changing W0–W8 commits or blindly merging `wip/m4-standalone-sqlite`.

---

## 3. Decisions required before implementation

**Status: the project owner approved the items marked "Approved (D49)" below in this conversation** (`DECISIONS.md` D49). Rows without that marker (W9-D2, D3, D5, D6, D8, D10, D14) are engineering-architecture confirmations or still-open items, not business approvals, and are unaffected by this approval. Approval of the decision sheet does **not** authorize W9.2 implementation by itself — that remains a separate, explicit task.

| ID | Decision | Recommended position (post-W9.1 review) | Why it matters | Approval owner | Status |
|---|---|---|---|---|---|
| W9-D1 (= sheet A) | Maximum offline grant duration | 8 hours (one shift), subject to approval against actual BPO shift patterns | Limits stale permissions and exposure when a device is lost | Business/operations + security | Approved (D49) |
| W9-D2 | Lease scope granularity | Explicit asset IDs; frozen work package; explicit stock quantities and PO line ceilings | Dynamic categories/locations can overlap or change unexpectedly | Engineering (architecture, not business) | Confirmed by D48's C1 review |
| W9-D3 | What can be done offline in the first pilot | Asset audit observations (not discrepancy *resolution* — see D48 addition), maintenance notes/tickets, and issue/transfer/return only for exclusively leased asset scopes; expand after evidence | Reduces risk while the protocol matures | Business/operations | Confirmed by D48 |
| W9-D4 | Approval work items | Specific request + step + named approver/device + policy snapshot + amount/currency bound | An approval can depend on policy and budget changes that happen online | Procurement/finance owner | Approved online-only for the first release (D49) — procurement itself deferred |
| W9-D5 | Expired lease handling | Stop local writes; server retains reconciliation hold until sync or audited force-reclaim | Expiry alone does not prove the client stopped or the physical state is known | Engineering (architecture) | Confirmed |
| W9-D6 | After app restart while offline | Keep outbox readable/syncable but disable new offline mutations until online grant/time revalidation | Avoids unsafe lease-age reconstruction across process/boot changes | Engineering (architecture) | Confirmed |
| W9-D7 (= sheet B) | Local device trust | Managed Windows devices, full-disk encryption (BitLocker), controlled IT administration; **a device failing this baseline is refused enrollment, not enrolled with reduced trust** | A local admin can otherwise copy/tamper with sensitive state | IT/security owner | Approved (D49) |
| W9-D8 | Offline user authentication | Online sign-in required to provision bounded offline grant; local unlock policy separately reviewed | Revocation cannot be instant during disconnection | Security owner | Confirmed direction; local-unlock design still open |
| W9-D9 (= sheet D) | Asset-code range allocation | Reserve non-overlapping sequence ranges online under the *same* `asset_code_config` row lock `issueAssetCode`/`updateAssetCodeConfig` already take (D48 C3); never reuse; **block prefix/separator/padding changes while any range has an unused tail** | Sequential server asset codes cannot safely be generated independently by disconnected clients without reservations | Asset/catalogue owner | Approved (D49) |
| W9-D10 | Local data protection | NTFS ACL + BitLocker baseline; decide whether application-level SQLite encryption is required | Local cache includes employee and financial information | IT/security owner | Open |
| W9-D11 (= sheet C) | Offline document cache | Document **content** caching and new uploads disabled offline in the first release (U3 unresolved — every document is permanently `not_scanned`, so there is no "clean" tier to cache); **metadata only** (file name/purpose/entity link) may be cached read-only | Avoid caching `not_scanned` or rejected files | Security owner (ties to U3) | Approved (D49) |
| W9-D12 | Scope of offline procurement | Start with drafts; add approvals/receipts only via dedicated grants and reserved ceilings, **after** retrofitting the capacity queries named in D48 C2 | Approval and receiving have business-wide shared state | Procurement/finance owner | Approved online-only for the first release (D49) |
| W9-D13 (= sheet E) | Force-reclaim authority | A Super Admin or a separately designated recovery role (not the device's own user); documented reason; second-person review where practical; unreconciled outbox operations preserved for audit, never deleted | Reclaim can expose uncertainty about unreported physical actions | Business owner + security | Approved (D49) |
| W9-D14 | Pilot sites/devices | One small controlled pilot group, device register and physical stock-check process | Limits blast radius and makes support/reconciliation manageable | Business/operations | Open |
| W9-D15 (= sheet F, new) | Legacy migration vs. active leases | Block `legacyMigration.ts apply` while any offline lease is active in the target organization; `plan`/dry-run unaffected | The migration tool inserts bulk rows outside any lease/reservation accounting | Migration/operations owner | Approved (D49) |
| W9-D16 (= sheet G, new) | Central backup/restore vs. reclaimed leases | Add a restore-time check comparing every restored lease's fencing epoch against the live epoch sequence; a lease reclaimed/advanced after the backup's point-in-time is not reactivated by the restore | Restoring an old backup must not resurrect revoked offline write-authority | Operations owner (ties to B6) | Approved (D49) |

If the business cannot approve a safe answer for a workflow, that workflow remains online-only. Do not block all W9 planning over nonessential future features.

---

## 4. Phase plan

### W9.0 — Specification and approval (current task)

**Deliverables**
- `docs/BPO_ASSET_MANAGEMENT_W9_OFFLINE_AGENT_TAS_v1.0.md` (or the agreed repository path).
- `docs/BPO_ASSET_MANAGEMENT_W9_IMPLEMENTATION_PLAN_v1.0.md`.
- Updated decision list once the owner approves provisional policies.

**Acceptance criteria**
- Lease/partition model and impossible guarantees are explicit.
- Offline workflow matrix exists.
- Security/threat model and recovery limits are documented.
- No application code changed.

### W9.1 — Repository audit, threat model and protocol contracts (architecture review and decision-sheet approval complete)

**Done in this review (DECISIONS.md D48) and approved by the project owner (D49), with no code/migration/dependency changes:**
- Verified the Git tree and actual W0–W8 state directly (commit `19f23b7`, clean tree) rather than inferring from prior reports.
- Inspected the actual mutation paths in `assets.ts`, `allocations.ts`, `maintenance.ts`, `audits.ts`, `procurement.ts`, `purchasing.ts`, `legacyMigration.ts`, and the asset-code migration/config functions — not the historical prototype's schema, which lacks these modules entirely.
- Produced the UI reuse matrix (`web/` vs. the frozen prototype vs. the new agent) in D48.
- Resolved and **approved** C1 (lease-enforcement architecture: application-service checks at nine enumerated existing lock points, not a trigger as primary mechanism), C2 (procurement stays online-only; the three specific capacity queries needing a future retrofit are named), C3 (asset-code range reservation shares the existing `asset_code_config` row lock), and C4 (U1's offline-write design direction is now an accepted decision; implementation has not started).
- Raised and **the project owner approved** the decision sheet (A–G, §3 table).

**Still required before W9.2 can start (not done here, and not a business-approval matter — pure engineering work):**
- TypeScript types/schemas for device, lease, grant, operation envelope, sync receipt, cursor, and conflict — genuinely new code/types, out of scope for a documentation-only task.
- The lease-overlap PostgreSQL representation (table shapes, exclusion constraints) — architecture is approved (D48/D49 C1: enforce at the same points that already take `FOR UPDATE`) but the actual DDL is W9.2 work, not W9.1.

**Acceptance criteria**
- Approved ADRs for lease lifecycle, scope locking, auth/device trust, local data protection, conflict resolution, and first pilot workflows — **approved (D49).**
- No code until contracts/decisions are reviewed and approved — **met; W9.2 code itself remains a separate, not-yet-started task.**

### W9.2 — Server device and lease foundation — **Complete (DECISIONS.md D50)**

**Correction found during the D51 re-verification:** this section's enforcement work item (below) says the `assertNotLeased`-style check goes at "nine existing `FOR UPDATE` lock points," including `purchasing.ts` and `procurement.ts`. The actual implementation correctly adds it at only five files/six functions — `allocations.ts`'s shared lock helper, `assets.ts: changeLifecycle`, `maintenance.ts: createTicket`/`closeTicket`, `audits.ts: correctLocation` — and deliberately adds none to `purchasing.ts`/`procurement.ts`, since C2 keeps procurement online-only by construction (the lease `scope_type` CHECK constraint admits no procurement scope, so no procurement-scoped lease can ever exist to conflict with). The original count was an overcount in this plan, not a gap in the implementation.

**Work**
- Add versioned PostgreSQL migrations for registered devices, lease/work package records, explicit lease scopes/reservations, fencing epochs, operation receipts, device/user grants, sync cursor/change tracking, and conflicts as needed.
- Implement enrollment/approval/revocation endpoints.
- Implement lease request, issue, status, release, expiry, renewal and audited recovery/reclaim endpoints.
- Prevent overlapping grants transactionally, including concurrent lease requests.
- Block web API writes against actively leased scopes via the enforcement design D48/C1 names explicitly: add the shared `assertNotLeased()` check at each of the nine existing `FOR UPDATE` lock points in `assets.ts` (`changeLifecycle`), `allocations.ts` (the shared issue/transfer/return/inspect/report-lost lock helper), `maintenance.ts` (per-function ticket/asset locks), `audits.ts` (per-function item/audit locks — **and add the currently-missing `FOR UPDATE` on `assets` in `correctLocation`, found during this review**), `purchasing.ts` (PO item locks), and `procurement.ts` (request item locks). A database trigger on `assets`/`asset_assignments` may be added afterward as defense-in-depth, not as a substitute for this enumerated list.
- Block `legacyMigration.ts apply` while a lease is active in the target organization (W9-D15/sheet F) — a single preflight check, not new migration-tool architecture.
- Add audit events, authorization checks, schema validation, and idempotency.

**Acceptance criteria**
- Concurrent overlapping lease requests: at most one succeeds.
- All nine enumerated online mutation call sites honor active lease locks — tested individually, not asserted as a class.
- Revoke/expire/reclaim advances or invalidates fencing authority.
- Cross-organization attempts are rejected.
- A legacy-migration `apply` attempt is refused while a lease is active in the target organization; `plan` is unaffected.
- A central-database restore does not reactivate a lease that was reclaimed/advanced after the backup's point-in-time (W9-D16/sheet G) — add this as an explicit restore-verification step in `docs/BACKUP_RECOVERY.md` alongside its existing checklist, not a parallel procedure.

### W9.3 — Desktop shell, local SQLite and offline grants — **Phase 1 (shell + local DB foundation) complete**
New `agent/` tree (Electron main/preload/renderer, independent of `src/` and of `web/`): secure shell (context isolation on, Node integration off, sandboxed, custom-scheme CSP, same verified pattern as the prototype's `src/main/app/security.ts` but new, standalone code — no runtime dependency on the frozen prototype); a new, separate, forward-only SQLite migrator and schema (`agent/main/db/`, `local_device` table only — no lease/outbox/business data yet); a one-command allow-listed preload (`device.getLocalDevice`) proving the IPC pattern end-to-end; `src/shared/clientApi.ts` with the smallest useful `CloudCommandClient`/`LocalDeviceStore` interfaces (not yet wired into `web/`). No lease acquisition, sync, outbox, or offline mutation exists — explicitly out of scope for this phase. Not yet wired into a runnable `agent:dev`/`agent:build` script (next step). 9 new tests (`tests/agent/*.test.ts`) cover shell security config, origin trust/path-traversal checks, fresh-DB migration, idempotent reopen, checksum-tamper detection, migration-failure rollback, and the preload allow-list.


**Work**
- Audit the historical Electron prototype. Reuse renderer/UI and secure preload patterns where appropriate, but build a new W9 local schema/migration path rather than adopting old SQLite migrations blindly.
- Create device enrollment UX and status.
- Implement protected local database path, WAL/backup behavior as appropriate, device key handling, grant verification and offline expiry gate.
- Implement local login/unlock using approved bounded offline grants.
- Build cache model for permitted records and show cache freshness.
- Implement a transactional outbox and local audit events.
- Make local mutations visible as provisional/pending.

**Acceptance criteria**
- Renderer cannot access Node, database, filesystem, or device keys directly.
- Local mutation + outbox + audit append are atomic.
- Invalid, expired, unknown, or altered grants block offline writes.
- App restart while offline preserves pending operations but blocks new offline mutations under the baseline rule.
- Backup/restore cannot duplicate device authority on another machine.

### W9.4 — Sync protocol and conflict engine

**Status update (W9.7):** a first, narrower slice of this exists now, not the full protocol below. `offlineSync.uploadObservation`/`uploadMaintenanceRequest` (DECISIONS.md D52) verify lease/fencing authority against real server state (the "verify device signatures and lease/fencing authority" bullet) and enforce one-operation-per-client-record-id via a permanent dedup table plus the existing idempotency-key machinery (the "same operation ID... rejected"/"duplicate batches" acceptance criteria, for these two record types specifically). **Gated off by default** (`SYNC_UPLOADS_ENABLED=false`) because W-44 (restore-safe fencing) and W-45 (device-trust acceptance) are both still unresolved. Not yet built: the versioned handshake, outbox batch upload, incremental download/cursors, conflict queue, or any operation type beyond these two read-mostly record kinds -- full sync remains future work.

**Work**
- Implement versioned sync handshake, status/receipt lookup, outbox batch upload, incremental download, cursor handling, operation acknowledgement, conflict queue, retry/backoff and progress.
- Verify device signatures and lease/fencing authority.
- Enforce operation IDs and payload-hash rules.
- Apply downloads transactionally and advance cursors atomically.
- Support dependency chains and per-aggregate sequencing.
- Add conflict details and administrative resolution records.

**Acceptance criteria**
- Timeout after server commit followed by retry produces one operation.
- Same operation ID with different payload is rejected.
- Duplicate/out-of-order batches do not corrupt local state or advance cursors incorrectly.
- Rejected/dependent operations remain visible and are never silently deleted.

### W9.5 — First offline workflow slice

**Status update (W9.5):** the first bullet below ("cached read-only inventory for the work-package scope") is now implemented as described, superseding W9.4's unscoped, organization-wide download. A new server command, `leases.getScopedAssets` (input: `leaseId` only -- never a client-supplied asset list), derives the authorized asset set from the real lease/`offline_lease_scopes` records and rejects a lease the caller doesn't own; the agent downloads via this command, tags the local snapshot with the lease ID, and a full wipe-then-replace on every download prevents a previous work package's assets from leaking into the next. The remaining bullets (audit observations, maintenance, issue/transfer/return) remain future work.

**Recommended initial slice (confirmed by the W9.1 review against the actual dependency graph — no smaller slice needed):**
- cached read-only inventory for the work-package scope;
- physical audit *observations* against a frozen audit snapshot (`verifyItem`/`flagMissing`) — **discrepancy *resolution* (`correctLocation`, `acceptException`) stays online-only/draft-only in this slice**, since it mutates master asset data and was the specific path found missing a row lock during the W9.1 review; **status: implemented locally for the local cache** -- `agent/main/db/observationsRepository.ts` records `verifyItem`/`flagMissing` against the frozen lease-scoped snapshot, tagged `syncStatus: 'local_pending'` (never a server audit record, no upload exists yet);
- maintenance ticket/event creation on leased assets; **status: implemented locally** -- `agent/main/db/maintenanceRepository.ts` records a request-only subset (fault category, priority, description; no technician assignment, vendor info, or duplicate-ticket detection, since those need server-side state this process can't see offline) against the frozen lease-scoped snapshot, tagged `syncStatus: 'local_pending'` (never a server ticket, no upload exists yet);
- asset issue/transfer/return only for exact leased asset IDs and included dependencies, after database-level locking and conflict handling are proven;
- USB/manual scanner support in the desktop client.
- **Status update (W9.6):** the asset list/detail screens now run as the real `AssetsPage.tsx` inside the agent (not a reimplementation) -- `web/src/api.ts` gained a swappable `CallTransport` (defaulting to the unchanged browser HTTP implementation), and `agent/renderer-src/desktopApiAdapter.ts` serves `assets.search`/`assets.get` from the local cache while refusing every other command as "not available offline." The offline session passed to `AssetsPage` holds only `assets.view`, so the component's own existing permission checks (not new code) hide every create/edit/mutation control.

**Acceptance criteria**
- Real server + two independent local-agent databases can be tested concurrently.
- A lease holder can perform allowed operations offline and sync them after reconnect.
- Another web client/agent cannot mutate the leased asset scope.
- State transitions, history and audit events match online invariants after synchronization.
- Unsupported workflows (including audit discrepancy resolution) remain clearly blocked or draft-only.

### W9.6 — Procurement and approval work packages (blocked on the C2 retrofit, DECISIONS.md D48)

**Before any work in this phase starts:** retrofit the three capacity checks D48/C2 names explicitly — `purchasing.ts`'s `createOrder` (`alreadyOrdered`) and `createReceipt` (`acceptedSoFar`/`outstanding`) ceilings, and `procurement.ts`'s request-level ceiling — to subtract active offline reservations, not just committed rows. Until this retrofit lands and is tested, offline procurement is not safe to enable regardless of how complete the lease mechanism itself is.

**Work**
- Local purchase-request drafts.
- Offline approval grants bound to a specific request, approval step, named approver, request revision, policy version, amount and currency.
- Offline PO-line and receipt-capacity reservations.
- Bulk-stock quantity reservations and ledger reconciliation.
- Reserved asset-code number ranges for offline asset creation, sharing the `asset_code_config` row lock per D48/C3 (no new locking primitive).

**Acceptance criteria**
- Concurrent leases cannot reserve the same approval work item, PO-line quantity, stock quantity or asset-code range.
- Policy snapshots are respected and no offline grant bypasses current server authorization rules.
- Receipts cannot exceed the reserved accepted/damaged quantity ceilings.
- Asset codes are never duplicated or reused.

This phase can be deferred if the owner chooses to limit the initial offline pilot to inventory/maintenance/audit/custody. Do not implement it by expanding asset leases to unrelated procurement records.

### W9.7 — Failure, security and recovery validation

**Required test scenarios**
- Network drops before local commit, after local commit, during upload, after server commit but before response, and during download.
- Five or more concurrent requests for overlapping leases.
- Two independent agents attempt to mutate the same leased asset; second grant denied.
- Lease expires during a prolonged disconnection.
- Device revoked while offline; reconnect then sync.
- Clock rollback, sleep/resume, app restart, OS reboot, copied database, altered outbox payload, unavailable device key.
- PostgreSQL unavailable/restarted during sync.
- Object upload partially succeeds, local attachment missing/corrupt, or checksum mismatch.
- Parent operation rejected and dependent operations pending.
- Device lost, force-reclaimed, then old device reconnects with stale fencing epoch.
- Server's authoritative asset assignment and local provisional assignment diverge.
- Backup/restore with pending outbox and conflict state.
- Windows packaged installer and upgrade with local database migration.
- **(W9.1 review additions, DECISIONS.md D48)** A legacy-migration `apply` attempted while a lease is active in the target organization is refused; `plan` still succeeds.
- **(D48)** A central-database restore to a point-in-time before a lease was reclaimed/advanced, followed by a sync attempt from the reclaimed device: the sync is refused, not silently accepted.
- **(D48, only once W9.6 is in scope)** A concurrent online request and an active offline reservation against the same PO line/stock item/request ceiling: the combined consumption never exceeds the limit, and whichever arrives second is rejected or queued, never silently double-booked.
- **(D48)** `correctLocation`/`acceptException` attempted offline against a leased audit are rejected or saved as drafts only, never applied as a master-data mutation.

**Acceptance criteria**
- No silent loss of pending operations.
- No duplicate central effects after retries.
- Stale or revoked authority cannot mutate current server state.
- Conflicts are visible and recoverable.
- The four D48 additions above each have a passing, real-PostgreSQL test (two of them — the two-agent capacity race and the restore/reclaim race — require real concurrent processes, not a single-threaded simulation).
- Known residual risks, especially physical uncertainty and local-admin compromise, are acknowledged.

### W9.8 — Controlled pilot and rollout decision

**Work**
- Select a small set of managed Windows devices and named operators.
- Enroll devices online and issue small-scope leases.
- Train users on provisional local actions, expiry, pending sync, conflict queues and support escalation.
- Perform scripted outages and recovery exercises.
- Reconcile physical asset status and the central server after each pilot run.
- Review telemetry, conflicts, rejected operations, lease duration and recovery actions.

**Acceptance criteria**
- Business owner approves the exact offline workflows and residual risks.
- Every pilot device is registered and recoverable/decommissionable.
- Backup/restore and revocation procedures are tested.
- No unresolved critical sync conflict or data-loss issue remains.
- A go/no-go record is signed before broader rollout.

---

## 5. Milestone release gates

| Gate | Must pass before continuing |
|---|---|
| G1 — Design approved | Lease/partition invariants, initial workflow scope, TTL, auth and recovery policies decided |
| G2 — Server lease safety | No overlapping lease issuance; online writes honor reservations; fencing/revocation tested |
| G3 — Local durability/security | Atomic outbox, protected device identity, expiry gate, backup/restore and packaged-app checks pass |
| G4 — Sync correctness | Idempotency, batch atomicity, cursor safety, ordering and conflict queue tested under faults |
| G5 — Business workflow slice | Initial offline workflows operate end-to-end with two devices and the existing cloud app |
| G6 — Expanded workflows | Procurement/approval/stock/code reservations pass if included in W9 scope |
| G7 — Pilot readiness | Cloud/provider configuration, logging/monitoring, backup, recovery, security review, training and owner sign-off complete |

Do not proceed past a failed safety gate by marking the feature as supported. Keep it online-only until fixed.

---

## 6. Regression requirements

Every W9 phase must retain the current cloud behavior:

- W1–W8 server and browser tests remain passing.
- PostgreSQL continues to be authoritative.
- Normal web users retain current online workflows except that mutations against an actively leased scope must be blocked or clearly constrained.
- Existing idempotency, response filtering, organization checks and audit requirements remain enforced.
- The historical Electron prototype remains buildable/tested if it is still part of project regression policy, but it is not the new agent's data source.

Run real PostgreSQL tests, real local SQLite tests, packaged Windows tests, browser E2E, and two-agent synchronization tests. Mock-only unit tests are not enough for lease overlap, fencing and atomic sync guarantees.

---

## 7. Token-efficient development workflow

- Read `PROJECT_STATUS.md`, relevant `DECISIONS.md` entries, `IMPLEMENTATION_PLAN.md`, and the current W9 phase state at session start.
- Inspect only source files related to the current gate.
- Use one primary coding agent by default; use subagents only for bounded independent audits.
- Avoid full repository dumps and repeated dependency research.
- Run targeted tests after each logical slice, then full regression at gates.
- Persist implementation notes, failed scenarios, exact tests and next steps in repository docs.
- Never assert that sync is safe from passing happy-path tests alone.

---

## 8. Definition of W9 completion

W9 is complete only when the agreed offline workflow set operates in the Windows desktop agent with bounded exclusive authority; the existing cloud service remains authoritative; leases cannot overlap; operations are atomic and idempotent; sync cursors and dependencies are safe; stale grants are fenced; conflicts are reviewable; local data is protected and recoverable; failure/revocation/restart cases are tested; W0–W8 regression remains passing; and the BPO owner signs off the pilot risk and operating procedures.

A completed W9 implementation does **not** mean all operations are safe during unlimited disconnection, that remote revocation is instantaneous, or that a compromised machine cannot misrepresent physical activity. Those guarantees are explicitly outside the system's technical capability without stronger operating controls.
