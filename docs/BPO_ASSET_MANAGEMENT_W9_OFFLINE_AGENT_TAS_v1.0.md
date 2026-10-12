# BPO Asset Management System
## W9 Technical Architecture Specification — Offline Desktop Agent v1.0

**Status: SUPERSEDED (DECISIONS.md D53).** The project owner changed the product direction to cloud-only; no Electron desktop agent will be built or shipped. The desktop-agent portions of this document (W9.3+: local SQLite, outbox, sync protocol, desktop shell/UI) are historical design record only. The server-side foundations this spec describes (device enrollment/leases, W9.2/D50; sync ingestion, W9.7/D52) remain implemented and in use by the cloud web app.  
**Version:** 1.0  
**Scope:** Controlled offline operation through a Windows desktop agent  
**Parent specification:** `BPO_ASSET_MANAGEMENT_TAS_v2.0.md`  
**Current cloud platform:** React + TypeScript, Fastify + TypeScript, PostgreSQL, S3-compatible storage  
**Proposed desktop client:** Electron + React + TypeScript + local SQLite  
**Central authority:** Existing cloud API and PostgreSQL remain authoritative  
**Initial tenancy:** One BPO organization; future SaaS tenant isolation remains a separate security gate

> **Change boundary:** W9 adds an offline-capable desktop client to the existing cloud application. It does not replace W0–W8, change the browser application into a desktop-only product, or authorize rewrites to prior commits. The historical Electron/SQLite prototype is a code and UI reference, not a trusted source of new offline synchronization logic.

---

## 0. W9.1 review status and project-owner approval (read before the rest of this document)

This v1.0 draft underwent an architecture review (W9.1) that resolved its four critical open findings (C1–C4) into concrete recommendations and raised a seven-item decision sheet (A–G). **The project owner has approved the decision sheet and the accepted architectural recommendations** (`DECISIONS.md` D49); the full resolutions, the UI-reuse matrix, and the exact code locations inspected remain recorded in D48/D49 — not duplicated here, to avoid two specifications drifting apart. Section-level pointers:

- **UI reuse** (how the new agent relates to `web/` vs. the frozen prototype): D48 "UI reuse assessment."
- **§4.4 (preventing overlapping authority) / C1:** approved — application-service enforcement at nine existing, enumerated row-lock call sites across `assets.ts`, `allocations.ts`, `maintenance.ts`, `audits.ts`, `purchasing.ts`, `procurement.ts`; a database trigger on `assets`/`asset_assignments` may be added later as defense-in-depth, not as the primary mechanism. See D48 "C1" / D49.
- **§6/§11.4 (procurement capability) / C2:** approved online-only for the entire first release. The specific existing capacity queries that must be retrofitted before offline procurement can ever ship are named in D48 "C2" (`purchasing.ts` order/receipt ceilings, `procurement.ts` request-level ceiling).
- **§4.3/§7.4 (asset-code ranges) / C3:** approved — a range reservation is a third operation sharing the same `asset_code_config` row lock `issueAssetCode`/`updateAssetCodeConfig` already take; format changes are blocked while unused ranges remain outstanding. See D48 "C3" / D49 "D."
- **U1 status / C4:** **the offline-write design direction is now an accepted decision** (D49), superseding the earlier "deferred" classification. This is not the same as implementation: W9.2 (actual lease/device/sync code) has not started under this task, and U1 remains "not implemented" in the running application until it does.
- **Decision sheet A–G** (grant TTL, device trust, offline documents, asset-code format changes, force-reclaim authority, legacy migration vs. active leases, backup/restore vs. reclaimed leases): **approved by the project owner** — see D49 for the exact approved wording of each.
- **First workflow slice:** confirmed as proposed (§6, implementation plan §4 W9.5), with one addition — audit discrepancy *resolution* (`correctLocation`/`acceptException`) is explicitly online-only/draft-only in this slice, not just observation.
- **Acceptance criteria:** §17 gains the additions listed in D48's "Acceptance-criteria additions and test-timing classification," including which tests can run with server-only W9.2 code versus which require two real desktop agents.
- **Scope note:** this approval authorizes W9.1 documentation finalization only. W9.2 (synchronization implementation) is explicitly out of scope for the task that recorded this approval and has not started.
- **W9.2 update:** the server-side device/lease foundation described above is now implemented and tested against real PostgreSQL — see D50. The enforcement call-site count in D48/§0 above (nine, including `purchasing.ts`/`procurement.ts`) is corrected by D50/D51: only five files/six functions actually needed the check (`allocations.ts`'s shared lock helper, `assets.changeLifecycle`, `maintenance.createTicket`/`closeTicket`, `audits.correctLocation`) — `purchasing.ts`/`procurement.ts` need none, by construction, since the lease scope type structurally admits no procurement scope (C2). An updated reuse matrix covering local storage, auth, business logic, sync and packaging, plus one material risk found (device trust is attestation-only, no automated device-management/MDM baseline check), is recorded in D51.

---

## 1. Executive decision

Add a Windows Electron desktop agent that can perform a bounded set of authorized business operations while disconnected, save those operations in a local SQLite database, and synchronize them with the existing Fastify API when connectivity returns.

The cloud system remains the central source of truth. The desktop database is a local working store and durable outbox, not a second independent authoritative database.

The selected operating policy is **controlled offline operation using exclusive offline write-authority leases or partitions**. Before a device may change a shared entity offline, the server must issue an explicit, time-bounded grant reserving that entity or bounded work package to that device. Online clients and other offline agents must be prevented from making conflicting mutations while that reservation is active.

A lease is not ownership of the physical asset and is not an assignment to an employee. It is exclusive authority for one registered device to record specified operations against a specified set of records during a bounded offline period.

### 1.1 Primary invariants

1. PostgreSQL remains the central authoritative store.
2. No asset or business record may have overlapping active offline write-authority grants for conflicting mutation scopes.
3. While a grant is active, the server blocks conflicting web or other-agent mutations against the granted scope.
4. The desktop records a business mutation and its outbox operation atomically in SQLite.
5. A local write is shown as **Pending sync / Provisional locally**, never **Cloud confirmed**, until the server accepts it.
6. Retries do not apply the same operation twice; every operation has a stable operation ID and canonical payload hash.
7. No silent last-write-wins for asset custody, approvals, receipt quantities, lifecycle, or financial decisions.
8. An expired, revoked, tampered, or otherwise unverifiable lease cannot authorize new offline writes.
9. Lease expiry does not automatically release the server-side reservation if unsynchronized operations remain. The scope enters reconciliation/quarantine until safely reconciled or explicitly reclaimed.
10. Audit history records the local actor/device, operation identity, lease/fencing epoch, server receipt/result, and conflict resolution without logging secrets.
11. The application fails closed when it cannot prove that a proposed offline operation is within the cached user's permissions and current device grant.
12. Business actions that cannot be safely partitioned or pre-authorized remain online-only until a specific offline protocol is approved.

---

## 2. Scope and non-goals

### 2.1 W9 objective

Provide the architecture and phased implementation for:

- device registration and revocation;
- server-issued offline work packages and exclusive leases;
- protected local SQLite persistence;
- offline authentication/authorization with bounded validity;
- transactional outbox and inbound change cursor;
- authenticated, idempotent synchronization APIs;
- conflict classification and a human-review queue;
- per-workflow offline capability rules;
- local and server-side audit trail continuity;
- recovery, support diagnostics, and operational rollout.

### 2.2 Not promised by W9

W9 cannot provide globally instantaneous consistency while devices are disconnected. It does not make all operations unconditionally safe offline, prevent a physically impossible action from having occurred, or provide secure remote revocation to a disconnected machine immediately.

W9 does not add microservices, Kafka or another message broker, Kubernetes, a second cloud database, or a new server-of-record. Use the existing modular Fastify application and PostgreSQL unless a measured need proves otherwise.

W9 does not enable all offline workflows in one release. Capability is introduced in gated slices after the underlying operation has a defined lease scope, dependency set, permission snapshot, reconciliation policy, and tests.

---

## 3. Architecture

```text
                         CLOUD — AUTHORITATIVE
  Browser clients ---------------------------------------------+
       |                                                       |
       +---------------- HTTPS --------------------------------+
                                                               v
                                                   +----------------------+
                                                   | Existing Fastify API |
                                                   | Auth / RBAC / domain |
                                                   | Sync + lease service |
                                                   +----------+-----------+
                                                              |
                                                    PostgreSQL + S3
                                                              ^
                                                              | HTTPS sync
                                                              | operations,
                                                              | changes, ACKs
                                                              v
  WINDOWS DESKTOP AGENT                                      
  +---------------------------------------------------------------+
  | Electron main process                                        |
  |  - local domain command handler                               |
  |  - lease/grant verifier and expiry gate                       |
  |  - sync orchestrator                                          |
  |  - OS-protected device-key access                              |
  |  - audit/diagnostic logging                                    |
  |             |                                                  |
  |  React renderer -- typed, allow-listed preload API             |
  |             |                                                  |
  |  SQLite: local snapshot + local transactions + durable outbox  |
  |  Protected cache: minimal reference data + explicitly allowed  |
  |                  attachments only                             |
  +---------------------------------------------------------------+
```

### 3.1 Application layers

- **Renderer:** reused React screens where sensible; no direct Node, filesystem, SQL, crypto-key, or arbitrary IPC access.
- **Preload:** narrow, typed, allow-listed commands only.
- **Electron main:** local database access, local authorization gate, lease validation, offline command handling, synchronization, document cache coordination, and protected key operations.
- **Local SQLite:** a versioned local schema. Domain change and outbox append occur in the same transaction.
- **Cloud API:** validates device, lease, user grant, operation type, organization, expected revision, fencing token, payload hash, and business invariants before accepting operations.
- **PostgreSQL:** authoritative entity data, lease state, lease scope, device registry, sync receipt records, conflicts, server audit events, and download cursor state.
- **Object storage:** remains the central store for documents. Offline document caching is a limited, explicit capability rather than a mirror of all S3 objects.

### 3.2 Client security baseline

Use current supported Electron versions and follow the official security recommendations: context isolation, sandboxed renderer, disabled Node integration in the renderer, restrictive Content Security Policy, constrained navigation, sender/payload validation, and a narrow preload API. Electron documentation warns that exposing powerful APIs through the preload bridge can bypass the intended isolation if not carefully filtered. References: <https://www.electronjs.org/docs/latest/tutorial/security/> and <https://www.electronjs.org/docs/latest/tutorial/context-isolation>.

The desktop agent must use only application-packaged local renderer code. It must not load remote web pages into a privileged window.

### 3.3 Local data security

The local database and cached documents contain company and employee information. At minimum:

- store data under a protected Windows application-data directory, not the install directory or a network share;
- restrict filesystem ACLs to authorized Windows principals;
- require full-disk encryption such as BitLocker on managed production devices where available;
- protect device private keys and cached grant material through Windows-protected key storage/DPAPI or an evaluated equivalent;
- do not store raw server session tokens or long-lived cloud credentials in SQLite;
- keep cached data to the minimum required by granted offline work packages;
- define log redaction and local-data retention for logout, device revocation and uninstall.

Application-level database encryption is a security decision requiring a tested library and Windows packaging review. Do not invent custom encryption. If the BPO threat model requires resistance to a local Windows administrator, ordinary file ACLs and user-mode encryption are insufficient; record that limitation and evaluate managed-device controls/hardware-backed keys.

SQLite should remain a local database. Do not place a WAL-mode SQLite file on a network share for multi-computer concurrent access. SQLite documents that WAL requires processes using the database to be on the same host: <https://www.sqlite.org/wal.html> and <https://www.sqlite.org/useovernet.html>.

---

## 4. Definitions and lease model

### 4.1 Terms

- **Registered device:** a named, administratively approved desktop agent installation with a server-recognized device identity.
- **Offline work package:** a bounded collection of entity snapshots, allowed commands, permission grants, dependencies, data-retention limits, and lease records. It is prepared by the server while the device is online.
- **Offline write-authority lease:** a server-issued reservation that grants one device permission to perform specified mutations on a scope of entities during a bounded interval.
- **Partition:** a stable, explicit set of entity IDs or reserved capacity assigned exclusively to a device. Partition membership must be frozen for the grant; dynamic selectors such as "all laptops in this department" must not silently absorb new records during an offline period.
- **Fencing token/epoch:** a monotonically increasing server value that distinguishes a current grant from old or reclaimed grants. Operations carrying an old epoch cannot mutate central state.
- **Outbox operation:** one local business command durably queued for server submission.
- **Provisional local state:** a visible local state not yet accepted by PostgreSQL.
- **Reconciliation hold:** server-side lock/status preventing reallocation of a lease scope until queued operations are synchronized or an authorized recovery action resolves the risk.

### 4.2 Lease issuance

Leases are created only while connected to the authoritative server. The API must:

1. authenticate the user and registered device;
2. check the user's permission to request a package;
3. verify that every entity and dependency is in a permitted state;
4. verify there are no conflicting existing leases;
5. define the exact entity set and allowed operations;
6. snapshot relevant entity revisions, approval-policy version, and allowed data dependencies;
7. reserve the entity scope from conflicting online and other-agent writes;
8. assign a unique lease ID and a strictly increasing fencing epoch;
9. issue server-signed lease/grant material including the organization, device, user/grant scope, operation allow-list, issue time, expiry, schema/protocol version, and permitted data scope;
10. record the lease and its audit event transactionally.

A caller cannot create or expand its own lease, edit a lease scope, change the expiry, or make a lease active solely by modifying local data.

### 4.3 Lease scope

Use the narrowest scope that supports an operational task:

- **Asset scope:** explicit asset IDs, including their current assignment, allowed transitions, location and required references.
- **Frozen location/stock partition:** a server-generated snapshot of asset IDs, plus explicit reserved quantities for bulk stock. Avoid a free-form category/location predicate as the only lock.
- **Approval work item:** one specific submitted request and approval step, assigned to a named approver/device, with its policy snapshot and amount/currency constraints.
- **Purchase/receipt work package:** explicit PO line IDs, remaining quantities and monetary ceilings reserved to one device. Reservation accounting must not allow other online operations to consume the same ceiling.
- **New asset code range:** server-reserved, non-overlapping asset-number ranges tied to the current prefix/format version. Numbers are never reused; gaps are accepted.

General administration, user/role changes, approval-policy edits, device registration/revocation, global settings, and other operations that cannot be bounded safely remain online-only by default.

### 4.4 Preventing overlapping authority

The server must maintain a lease-scope index/reservation model that can transactionally detect conflicts. A lease can be issued only if its scope is disjoint from active grants, except for explicitly designed and tested compatible read-only scopes.

While an entity is leased to a disconnected device, ordinary web writes and other agents must be blocked or explicitly routed through a server-mediated process that cannot violate the exclusive grant. Read-only views may show a **managed offline by device X / data may be stale** indicator; they must not imply that their copy is current.

Conflicts must be enforced at the database/service boundary. Do not rely on a UI-only lock indicator.

### 4.5 Lease lifecycle

Recommended server states:

- `prepared` — scope reserved and bundle being delivered;
- `active` — client may perform the granted offline commands;
- `release_pending_sync` — client has reconnected/released, but server has not reconciled all queued operations;
- `expired_pending_reconciliation` — expiry passed; new local writes are prohibited, server scope remains held;
- `revoked_pending_reconciliation` — server revoked the grant; queued operations require controlled reconciliation and may be rejected;
- `reconciling` — uploads/downloads and server validation in progress;
- `reconciled` — all operations accepted/rejected/handled and scope safely released;
- `reclaimed_by_admin` — an authorized, audited force-reclaim followed a recovery procedure acknowledging possible unsynchronized physical activity.

Do not automatically reassign an expired lease's asset scope just because wall-clock expiry has passed. Expiry disables honest-client offline writes; it does not prove the disconnected device has synchronized or that the real-world state is known.

### 4.6 Offline expiry and reboot rule

- Grant validity is short and configurable; exact TTL requires operational risk approval before pilot.
- The client uses a monotonic elapsed-time source to enforce lease validity, not a mutable wall-clock timestamp alone.
- Validate behavior across Windows sleep/resume. If the app cannot prove that the lease has not expired, it blocks new offline mutations.
- Conservative baseline: after application restart while disconnected, offline write capability is disabled until the device can revalidate with the server. Existing outbox operations remain preserved and may be synchronized when reconnected. A future implementation may relax this only after proving a secure boot-session/monotonic-time design.
- At expiry, show a clear read-only/queued-work state; do not silently discard queued work.
- Local machine clock rollback must not extend lease validity.

### 4.7 Fencing and recovery

Every accepted operation carries the lease ID and fencing epoch. On revocation/reclaim, the server advances the epoch or otherwise invalidates prior authority. Stale operations are rejected or sent to manual review; they may not mutate current records.

If a device is lost or fails to return while offline, an authorized administrator may reclaim the scope only through a documented procedure: identify outstanding operations, assess physical status, record evidence/reason, preserve the old lease and fencing epoch, and accept that unreported physical activity may remain uncertain. Do not imply that remote revocation reaches a disconnected machine instantly.

---

## 5. What can and cannot be guaranteed

### 5.1 Guarantees available with this design, under a conforming client

- The server will not knowingly issue overlapping leases for conflicting scopes.
- Online application mutations against actively leased records will be blocked or constrained.
- The desktop can durably record an allowed local operation and outbox item atomically.
- Retried sync requests can be deduplicated by stable operation ID and payload hash.
- Old fencing epochs can be rejected after revocation/reclaim.
- Accepted server changes remain subject to PostgreSQL constraints and the existing domain rules.
- Pending, accepted, rejected and review-required operations can be distinguished and shown to users.

### 5.2 Guarantees that are impossible during arbitrary disconnection

1. **Instant global consistency:** the server cannot know about an operation it has not received.
2. **Instant revocation:** password changes, role revocation, employee termination, or device revocation cannot immediately reach a disconnected machine. The bounded offline grant limits exposure but cannot eliminate the interval.
3. **Perfect freshness:** cached people, asset status, policy, and location data may be stale.
4. **Arbitrary conflicting offline edits:** two independent clients cannot safely write the same mutable entity without exclusive ownership or a reconciliation outcome.
5. **Certain proof of real-world events:** software can record that an operator says a laptop was handed over, but it cannot prove the physical handover occurred correctly.
6. **Absolute lease-time proof on an untrusted endpoint:** software-only elapsed-time checks cannot defeat a sufficiently compromised local administrator. Hardware-backed keys/device management can raise assurance but still do not make a remote server observe physical reality.
7. **Guaranteed zero rejected operations after reconnect:** a server may reject an operation if its lease was revoked, its dependency was invalid, the payload was altered, the schema/policy no longer permits it, or the trusted-device assumptions failed.
8. **Immediate global approval correctness:** a locally made approval cannot see intervening changes to other requests, budgets, permissions or policies unless the relevant authority and dependencies were explicitly reserved in the work package.

The product must show these limitations in user/admin documentation. Never label a locally saved operation as centrally committed until the server confirms it.

---

## 6. Offline capability matrix

Offline execution is allowed only when the user, device, operation, dependencies and entity scope are all covered by a valid work package. This matrix is the starting policy; any expansion requires a decision and tests.

| Workflow | Proposed offline behavior | Required grant/reservation | Reconnect handling |
|---|---|---|---|
| View cached inventory/employee/location data | Allowed for data within the user's cached scope; marked with last sync time | Read grant + bounded cache | Refresh server snapshot; show stale/changed items |
| Search/scan an asset | Allowed locally within cached/granted records | Asset snapshot in work package | Resolve ID against server when online |
| Create a new asset | Allowed only after an asset-code range and creation capability are reserved; otherwise local draft only | Code range, category policy, allowed site/location scope | Validate serial uniqueness/metadata and insert; conflict goes to review, code is never reused |
| Issue, transfer, return, inspect asset | Allowed only for assets in exclusive lease scope | Asset IDs, base revisions, allowed transitions and targets | Serialize in device sequence; server enforces constraints; stale/fenced op rejected or reviewed |
| Maintenance ticket/note | Allowed for leased assets and permitted ticket actions | Asset lease and allowed maintenance commands | Create events idempotently; independent notes append rather than overwrite |
| Physical audit observations | Allowed against frozen audit snapshot and assigned scope | Audit ID/snapshot, item partition, observation capability | Append observations; conflicting master-data changes become discrepancies, not silent overwrite |
| Create employee/organizational record | Local draft allowed; authoritative creation only within explicit create/import grant with uniqueness considerations | Specific create grant and required reference snapshots | Conflicts on employee code/email/reference block dependent actions or require review |
| CSV employee import | Local preview allowed; offline commit only if the full import scope and required references were explicitly reserved; otherwise draft/staged only | Import session ID, immutable file fingerprint, row set, reference snapshot | All-or-nothing server validation; report accepted/rejected/conflicting rows clearly |
| Purchase-request draft | Allowed locally | Draft capability; local UUID | Sync as draft; server validates references and numbers |
| Submit/approve purchase request | Allowed only for a pre-authorized specific approval/work item whose policy version and amount limits are snapshotted; otherwise online-only | Exclusive approval-step work item, named user/device, policy snapshot and limits | Server validates authority, grant, request revision and idempotency; conflict to review |
| Purchase order amendment | Offline only with a specific reserved order/line and approved ceiling; otherwise online-only | PO/line lease, policy/amount/currency constraints | Reject if authority or ceiling was not valid; preserve amendment history |
| Goods receipt | Offline only for leased PO lines and reserved remaining quantities; rejected/damaged outcomes explicit | Exclusive PO-line capacity reservation | Server locks line, validates capacity and idempotency; conflicting receipt goes to review, never silently over-receives |
| Exit clearance | Offline item returns/observations only if underlying assignments and all clearance items are leased; final closure normally online-only unless a dedicated closure grant is issued | Clearance + associated assignments/items, explicit authority snapshot | Server recomputes outstanding items; closure rejected/reviewed if new or conflicting outstanding records exist |
| Retire/dispose/mark lost | Default online-only; a bounded offline lost-report draft may be permitted, but final disposal/write-off needs current authority | Explicit exceptional lifecycle grant if later approved | No silent closure of assignment; authoritative review required |
| Change users, roles, permissions, approval policies, organization/security settings | Online-only | Not leaseable by default | No offline mutation accepted |
| Password reset, account/device revocation, SSO, global config | Online-only | Not leaseable | Revalidate once online |
| Financial reports/depreciation | Cached read-only report only, clearly dated; no depreciation if Finance policy remains unresolved | Bounded read grant and permitted fields | Refresh and re-run on server |

### 6.1 Business scope limits

A lease must cover dependencies, not just the primary asset. For example, offline transfer may require the asset, its current assignment, target employee/workstation/pool, relevant location records, the current permission grant, and handover policy. If any required dependency is missing or has not been reserved/snapshotted, the transaction is blocked or saved as a draft.

### 6.2 Bulk stock

For quantity-tracked inventory, reserve a quantity capacity against the exact stock item/location/PO line. The sum of active reservations plus already committed use must not exceed available quantity. Local decrement is provisional; PostgreSQL validates reservation IDs and capacity at sync. Do not let several devices hold the same stock units.

---

## 7. Local database and outbox model

Use a new W9-specific SQLite migration stream in the desktop agent. Do not point the agent at the historical prototype database and do not reuse prototype migrations blindly.

Minimum local entities (exact columns to be reviewed during W9.1 design review):

- `local_schema_migrations`: local schema version/checksum.
- `device_identity`: stable device UUID, key identifier, enrollment status, last confirmed server time, protocol version.
- `cached_users`: minimal user identity and offline grant metadata; no raw tokens.
- `offline_grants`: signed server grant, lease ID, fencing epoch, permitted operations, issue/expiry metadata, scope hash, state.
- `entities_cache`: locally cached server records, organization ID, entity type, server revision/version, last sync cursor, freshness metadata.
- domain tables or a normalized local projection needed by supported workflows (assets, assignments, employee/location references, maintenance, procurement and audit scope as enabled).
- `outbox_operations`: unique operation UUID, device sequence, operation type, aggregate/entity IDs, lease/work-package ID, fencing epoch, base revisions, payload version, canonical payload, payload hash, signing key ID/signature, local capture metadata, status, attempt count and last error code.
- `sync_cursors`: last fully applied inbound cursor by organization/stream.
- `sync_receipts`: server acknowledgments/result IDs and rejection/conflict outcomes.
- `conflicts`: operation ID, entity IDs, conflict type, server response, assigned reviewer, resolution state, resolution/correction linkage.
- `cached_documents`: generated local cache key, source document ID/checksum, allowed grant, scan state, expiry/purge rule; only if offline file cache is approved.
- `local_audit_events`: append-only through the normal app path, including local actor/device and operation references.

### 7.1 Atomic local write

For a permitted offline mutation, use one SQLite transaction to:
1. validate local lease/grant, expiry, permission and required cached dependencies;
2. apply the provisional local projection or write an explicit provisional event where immediate projection is unsafe;
3. assign a stable operation ID and next per-device sequence;
4. write the canonical operation envelope and hash to the outbox;
5. append the local audit event;
6. commit.

If any step fails, no partial business mutation or outbox entry may remain.

### 7.2 Outbox states

Use explicit statuses such as:
- `pending` — ready for upload;
- `sending` — being submitted;
- `accepted` — server transaction committed;
- `rejected` — server definitively declined it;
- `needs_review` — conflict requires human decision;
- `blocked_dependency` — a prerequisite operation failed;
- `cancelled_locally` — permitted only when not already sent and the domain policy allows it.

Do not delete rejected/reviewed operations. Their payload retention, access controls and retention period must be configured. Never log sensitive full payloads by default.

### 7.3 Dependencies and ordering

Each operation identifies its parent aggregate and prerequisite operation IDs. Maintain order for operations affecting the same asset, PO line, approval item, or clearance. The server processes the dependency chain deterministically. Unrelated aggregates may sync in parallel only if doing so cannot violate dependency ordering. If parent creation is rejected, dependent operations become `blocked_dependency` rather than being silently dropped.

### 7.4 Asset-code reservation

The current human-readable code format remains `AST-000001` or the configured equivalent. Offline creation requires server-reserved, non-overlapping code ranges tied to an asset-code format version. The code generator must consume local reserved numbers transactionally and never recycle codes. When the range is exhausted or the format changes, new offline asset creation stops until online renewal. UUIDs remain internal record IDs.

---

## 8. Device identity, user authentication and local authorization

### 8.1 Device enrollment

- A device is enrolled only after an authenticated online enrollment and authorized admin approval.
- The device receives a stable UUID and a device key pair/identity suitable for signed operation envelopes.
- Prefer a non-exportable Windows-protected key where support and deployment testing allow; evaluate Windows CNG/TPM support instead of implementing custom cryptography.
- The server stores the public key/key ID, device owner, status, enrollment date, and revocation metadata.
- Device replacement/reinstallation creates a new enrollment unless a recovery procedure proves the prior identity can be safely restored.
- The historical prototype's device/database state is not automatically trusted or enrolled.

### 8.2 Offline user authentication

Offline access requires both a registered, currently granted device and a local user identity with a server-issued, time-bounded offline authorization bundle.

The bundle includes user ID, organization ID, role/permission snapshot or a minimal explicit operation allow-list, granted work package IDs, issue/expiry times, and revocation/version markers. Do not permit local role expansion.

A user must establish online authentication before obtaining or renewing offline grants. Local unlock credentials and cached verifiers require a security review before implementation; do not store plaintext passwords or reusable server session tokens in SQLite. Enforce local attempt throttling and idle lock. High-risk administrative operations stay online-only.

### 8.3 Revocation limits

Server-side account/device revocation is immediate for online requests but cannot be delivered instantaneously to a disconnected agent. Limit this exposure through short offline grants, least privilege, a strict expiry gate, and device-management policies. Upon reconnect, revalidate account and device state before synchronizing privileged operations. Define which already-captured operations may be accepted after revocation; default high-risk approval/disposal operations to rejection or manual review if authority was revoked before server acceptance, unless a formal risk decision says otherwise.

---

## 9. Synchronization protocol

### 9.1 API shape

Add versioned endpoints under the existing `/api/v1` policy. Exact route names should follow repository conventions, but capabilities must include:

- device enrollment/status/revoke;
- lease/work-package request, renewal, release, and status;
- sync handshake and server cursor;
- upload batch of signed outbox operations;
- operation receipt/status retrieval;
- incremental changes download;
- conflict detail/resolution;
- server time/grant validity recheck.

All endpoints use the existing authentication/CSRF/origin protections where applicable, request and response schemas, organization scoping, rate limits, audit practices, and idempotency standards.

### 9.2 Operation envelope

Each operation should carry, at minimum:
- `operation_id` UUID and idempotency key;
- `organization_id`, `device_id`, `user_id`;
- `lease_id` and fencing epoch;
- per-device sequence and protocol/payload version;
- operation type and target aggregate/entity ID;
- expected base revision(s);
- dependency operation IDs;
- canonical payload plus payload hash;
- local capture metadata and monotonic elapsed time since grant issuance;
- device signature/key ID.

Local wall-clock timestamps are useful diagnostics but are not sufficient proof that an operation occurred before expiry. Validate the grant on the client and server. State clearly that a compromised endpoint may falsify locally reported event time unless a stronger managed-device/hardware-attestation system is adopted.

### 9.3 Upload processing

For each operation, the server:
1. authenticates/enrolls the device and identifies the user;
2. verifies device signature and grant/lease/fencing epoch;
3. verifies the allowed operation and entity scope;
4. verifies idempotency key and payload hash;
5. checks dependency status and base revision;
6. checks organization ownership and current business invariants;
7. executes the domain transaction and audit events atomically;
8. stores a durable operation receipt with accepted/rejected/review result;
9. returns the canonical server entity revision and result.

An identical retry returns the stored receipt. Reusing an operation ID with a different payload is rejected. A server crash after commit but before response must not duplicate the business operation on retry.

### 9.4 Download processing

- Download changes in a stable server-defined order using an opaque cursor.
- Apply each inbound batch to SQLite transactionally, and advance the local cursor only in the same transaction as the complete batch application.
- Repeated batches must be safe.
- A gap, invalid cursor, incompatible schema or checksum failure triggers a resync/recovery path, not a partial cursor advance.
- Do not overwrite local unacknowledged state with a downloaded snapshot. Merge accepted receipts first; keep pending/failed local changes separate and visibly labelled.

### 9.5 Synchronization order

A reconnect cycle should:
1. establish TLS and revalidate device/user status;
2. fetch grant/lease status and outstanding operation receipts;
3. upload pending operations in dependency and per-aggregate order;
4. persist server receipts without dropping unsynced data;
5. obtain canonical changed records and the next cursor;
6. apply the inbound batch transactionally;
7. update the UI's sync state;
8. release or reconcile leases only when server rules are satisfied.

Do not claim an operation is synchronized until its server receipt states that the transaction was accepted.

---

## 10. Conflict policies

No global last-write-wins policy is allowed for business transactions. Conflict handling is operation-specific.

| Conflict | Required behavior |
|---|---|
| Same operation delivered twice, same payload | Return the original receipt; no duplicate effect |
| Same operation ID, different payload | Reject and flag a security/integrity event |
| Stale fencing epoch or revoked grant | Reject the mutation; preserve local operation for review |
| Asset lease conflicts with online web mutation | Web mutation should have been blocked centrally; if a legacy/exempt path is detected, quarantine and reconcile rather than silently accepting both |
| Two agents attempt to lease overlapping assets | Second grant denied transactionally |
| Operation references a dependency that failed sync | Mark `blocked_dependency`; retain for correction/review |
| Asset/employee/reference record changed despite a valid lease due to an exception or administrative intervention | Compare base revision; no overwrite. Send to manual conflict resolution |
| Employee code/email or asset serial uniqueness conflict | Reject dependent record/operation and its dependent chain; show correction workflow; do not silently merge employees/assets |
| Asset issue/transfer/return conflicts with current assignment | Preserve local observation and actor statement; server refuses conflicting assignment; require authorized investigation/correction |
| Approval policy changed after work package creation | Use the version explicitly snapshotted in the grant only if its offline authorization remains valid; otherwise reject/review. Policy changes must not silently reinterpret the pending approval |
| Approval decision is no longer authorized or request revision differs | Reject or manual-review; never silently re-route as if the prior decision applied to the new request |
| Purchase receipt exceeds leased PO capacity | Reject/review; never exceed accepted/remaining quantity or amount ceiling |
| Bulk-stock reservation conflicts | Reject/review and reconcile balance from movement ledger; no silent negative/overdrawn stock |
| Device lease expires with pending operations | Stop new local writes; retain scope in reconciliation hold; sync pending work or require an audited admin recovery |
| Document upload is pending/not scanned/scan failed | Do not represent as clean; apply the cloud U3 policy and block opening/redistribution where policy requires |
| User/device revoked while offline | Cannot revoke instantly. On reconnect, revalidate; apply the documented acceptance policy to operations captured before/after expiry/revocation |
| Physical event cannot be proved (e.g. an unreported handover occurred after device became untrusted) | Keep explicit uncertainty and exception; software cannot infer the real-world state |

A conflict-resolution UI must show the local claim, current server state, operation, actor/device, lease and time metadata, and available safe outcomes. Resolutions are new authorized correction/reversal transactions with a reason, not edits/deletions of history.

---

## 11. Workflow-specific reservations

### 11.1 Assets and assignments

- Lease each asset or a frozen partition of explicit assets.
- Include the current active assignment and required targets as dependencies.
- Block web writes to leased assets and assignments while offline authority is active.
- Transfers close the prior assignment and create the new assignment in one local transaction, then apply atomically at the server.
- Return and inspection actions carry condition and next-state intent; server policies remain authoritative at sync.
- Disposal/write-off remains online-only in the first W9 implementation unless a specific authorized exception grant is designed and approved.

### 11.2 Maintenance

- Offline maintenance ticket creation/notes are permitted only against leased assets.
- Events append; notes do not overwrite another user's notes.
- Ticket status transitions must be included in the allowed operations. Closing a ticket does not make an asset ready without the applicable release/inspection authority.
- Multiple distinct faults require an explicit reason and allowed permission as in W5.

### 11.3 Physical audits

- Issue an audit work package with a frozen expected-asset snapshot or assigned audit-item IDs.
- Offline scans append observations with operator/device, lease/work-package ID, and the observed identity/location/condition.
- Scans do not automatically edit master asset data or mark an asset lost.
- Discrepancy resolution that mutates shared master data requires the relevant entity lease or online connection.

### 11.4 Procurement and approvals

- Offline drafts may be created with UUIDs and synchronized as drafts.
- Offline approval requires a grant tied to a specific request/approval step, named user, snapshotted policy version, amount/currency bounds, and request revision.
- Offline PO amendment/receipt requires a reservation for the exact PO line, remaining quantity, amount ceiling and currency.
- Bulk stock is partitioned by reserved units, not merely by location name.
- Global approval-policy changes and user/role administration remain online-only.

### 11.5 Employee and reference data

- Cache only employee and reference records needed for the device's work package and user's permission scope.
- Offline edits to shared master data are drafts unless the server grants explicit exclusive authority for the record.
- Creation can use UUIDs locally; server-assigned employee codes and uniqueness requirements are validated before accepted state. Dependent operations block if record creation is rejected.
- User, role, device, organization/security and approval-policy administration remain online-only.

---

## 12. Documents and attachments

Central object storage remains the authoritative store.

- Offline attachments are written to a protected local staging area using generated local keys and stored checksums. An outbox operation references the attachment by an internal ID, not an arbitrary path.
- Synchronization uploads the object through the existing API/storage abstraction and then commits the metadata/link in the correct sequence. Use idempotent upload operation IDs and checksum verification.
- The server's malware scan state remains authoritative. Do not cache/open documents in offline mode if the central policy says `not_scanned`, `pending`, `scan_failed` or `rejected` files must be quarantined/blocked. **Reviewer note (consistency check against the current implementation):** today, every uploaded document is permanently `not_scanned` (no scanner is integrated; U3 is unresolved — DECISIONS.md D47), and the existing online download policy already allows `not_scanned` (`DOWNLOADABLE_SCAN_STATES` in `server/src/services/documents.ts`). If offline caching is held to the same bar as online download, `not_scanned` documents would be cacheable offline too, which is a materially different (and arguably riskier, given a portable disconnected device) posture than if offline caching is meant to require `clean` specifically. This document does not state which bar applies, and under current state those two readings produce opposite outcomes for every document that exists. This needs an explicit decision in W9.1/W9.2, not an inferred default — see the design-review report.
- Never treat an attachment as centrally present before upload receipt and metadata link have both succeeded.
- Orphan cleanup must account for delayed sync: do not delete local staged files or server objects while an outbox operation references them.
- Retention, cache deletion, and remote deletion require separate authorized operations; unlinking a local view must not silently destroy the central document.

U3 remains a production gate until malware-scanning policy and behavior are approved.

---

## 13. Backup, restore and lifecycle of offline data

### 13.1 Local backup

The desktop agent requires backup for local database state, the outbox, device/grant metadata that can safely be restored, pending attachment files, and local receipts/conflicts. Backups must be consistent with SQLite transaction/WAL state and include a manifest/checksums.

Do not copy only the SQLite main file while active WAL transactions may exist. Use SQLite's backup API or a tested consistent-close/checkpoint procedure. SQLite WAL's same-host limitation also means this local database is not a multi-computer shared database. References: <https://www.sqlite.org/backup.html> and <https://www.sqlite.org/wal.html>.

### 13.2 Restore policy

- Restoration must not clone a live device identity onto two machines.
- Restoring a database to a different computer creates a new device enrollment and must not restore old offline write authority automatically.
- Pending operations may be preserved for recovery/export but must be revalidated; do not issue new offline operations until the new device is online and enrolled.
- Preserve outbox payloads and their IDs during same-device recovery. Never regenerate IDs for already-sent operations.
- Test both normal backup/restore and recovery from a damaged/cut-off database.

### 13.3 Local retention

Specify retention and deletion rules for cached PII, attachments, acknowledged outbox items, rejection payloads and diagnostic logs. The agent must support a controlled device decommission path that syncs/exports pending work where possible, revokes the device online, then purges cached data and keys.

---

## 14. API and database additions (logical proposal)

Exact SQL DDL and route names are to be designed against the actual repository in W9.1/W9.2. Expected logical entities:

### Central PostgreSQL

- `sync_devices`: organization, stable device ID, public-key/key ID, status, last seen, software/protocol version, enrollment/revocation metadata.
- `offline_leases`: lease ID, organization, device, user/grant owner, state, issue/expiry, fencing epoch, scope digest, payload hash, release/reconciliation timestamps.
- `offline_lease_scopes`: explicit leased entity IDs and/or reserved quantity/capacity/amount, entity revision, allowed operations; normalized to support transactional overlap checking.
- `offline_grants`: signed grant material or reconstructable grant metadata, permission snapshot/version, allowed operation set, policy references, expiry.
- `sync_operation_receipts`: operation ID, organization, device, payload hash, accepted status/result ID, server sequence/correlation ID, result/error code and processing timestamp.
- `sync_cursors` or change-log sequence table: incremental download checkpoint per tenant/device/stream with retention policy.
- `sync_conflicts`: operation, affected entities, conflict category, server/client version references, status, assigned resolver and resolution transaction.
- audit events for enrollment, lease issue/renew/revoke/reclaim, sync acceptance/rejection, conflict resolution and device decommission.

Use unique constraints on operation ID within the required idempotency scope, per-device sequence where appropriate, non-overlapping lease scope, and document/version/hash relationships. Add constraints transactionally with server service checks. Do not assume a JSON scope list by itself guarantees non-overlap.

### Versioning

- Version local SQLite migrations separately from server PostgreSQL migrations.
- Version sync protocol and operation payload schema explicitly.
- The server must support a documented compatibility window for agent versions; incompatible clients must be blocked or forced to upgrade while online, not allowed to send unknown payload semantics.
- Unknown operation types are rejected safely.

---

## 15. Observability and user experience

The desktop UI must always show:
- connection state and last successful sync time;
- device enrollment status;
- current offline work package/lease and expiry state;
- number of pending, sending, accepted, rejected, dependency-blocked, and review-required operations;
- whether data shown is cached and potentially stale;
- why a specific operation is blocked offline;
- a visible conflict-resolution/support path.

Never show one generic green "Synced" indicator when any operations remain pending or require review.

Log correlation IDs, device ID, lease ID, operation ID, outcome and error code. Avoid logging passwords, tokens, document contents or unnecessary employee personal data. Logs must not imply server acceptance when only a local transaction committed.

---

## 16. Threat model and residual risk

Protect against accidental double-submission, network loss, request timeout after server commit, app restart, process crash, local database corruption, duplicate or out-of-order operations, stale cached data, expiry, lease overlap, partial document upload, and cross-organization authorization errors.

Assume some offline devices may be lost, stolen, or unavailable for long periods. Use minimal caches, bounded grants, device revocation, OS key protection and encrypted disks as appropriate.

Residual risks that need operational acceptance:
- A compromised local administrator may tamper with local data or exploit the agent to perform actions while disconnected.
- Device/user revocation cannot be immediate while offline.
- Physical actions may occur outside the recorded workflow.
- Force-reclaiming a lease can leave uncertainty if unsynchronized offline actions exist.
- A disconnected device cannot know current server changes outside its granted scope.

For high-assurance use, require managed Windows devices and assess hardware-backed keys/attestation. Do not claim that a client-side lease alone provides tamper-proof time or physical-state guarantees.

---

## 17. W9 acceptance criteria

> **W9.1 additions (DECISIONS.md D48):** every mutation path enumerated in D48's C1 table requires an explicit "online write blocked while leased" test (nine call sites, not a general claim); `issueAssetCode` racing a range reservation on the same organization; a format change blocked while a range is outstanding; a legacy-migration `apply` blocked while a lease is active; a restore-then-sync test proving a reclaimed lease cannot be reactivated by restoring an old backup; `correctLocation`/`acceptException` specifically rejected or draft-only offline. D48 also classifies which of these can run against server-only W9.2 code and which require two real desktop agents plus real PostgreSQL.

W9 may be considered pilot-ready only if all applicable checks pass:

1. A device can enroll online and receive an approved, bounded work package.
2. The server refuses overlapping leases for the same asset/scope, including concurrent requests.
3. Web and other-agent mutations against an active leased scope are blocked.
4. The agent can perform a permitted mutation offline and atomically persist both local state and outbox operation.
5. A failed local transaction writes neither partial state nor a partial outbox entry.
6. Network loss during upload and server commit followed by lost response results in one central business operation only.
7. Acknowledged operations retain stable IDs and server receipts across restart.
8. The client blocks writes after expiry, detected clock manipulation, uncertain expiry, or disconnected app restart; it preserves queued work.
9. The server refuses stale fencing epochs and conflicting/unleased operations.
10. Per-device and per-aggregate ordering is enforced, and dependent operations block safely if prerequisites fail.
11. Asset-code ranges never overlap and never reuse burned identifiers.
12. Offline procurement approvals/receipts are accepted only with their exact grant, policy snapshot and quantity/amount reservation.
13. A download batch is applied transactionally; the sync cursor never advances over a partially applied batch.
14. Conflict cases create review records with enough context and do not silently overwrite central state.
15. Device/user revocation limitations and force-reclaim recovery are explicit and tested.
16. Local backup/restore preserves pending operations but cannot clone device authority onto a second installation.
17. Sensitive fields, tokens and unsafe document contents are not exposed through the renderer, local logs, or sync reports.
18. Browser application and W0–W8 regression suites continue to pass.
19. Concurrency/failure tests use real PostgreSQL and realistic two-agent fixtures; they are not mocks only.
20. Pilot documentation explains pending/provisional versus server-confirmed actions and the recovery process.

Passing these tests establishes conformance to the agreed failure model; it does not prove zero physical conflicts or resistance to a fully compromised endpoint.

---

## 18. References

- Parent specification: `BPO_ASSET_MANAGEMENT_TAS_v2.0.md`.
- Cloud architecture: `docs/ARCHITECTURE_V2_CLOUD.md`.
- Open decisions and phase records: `DECISIONS.md`, `IMPLEMENTATION_PLAN.md`, `PROJECT_STATUS.md`, `KNOWN_ISSUES.md`.
- Electron security recommendations: <https://www.electronjs.org/docs/latest/tutorial/security/>.
- Electron context isolation: <https://www.electronjs.org/docs/latest/tutorial/context-isolation>.
- SQLite WAL same-host constraint: <https://www.sqlite.org/wal.html>.
- SQLite network-use caveats: <https://www.sqlite.org/useovernet.html>.
- SQLite backup API: <https://www.sqlite.org/backup.html>.

**Approval rule (updated):** The implementation plan has been reviewed, the initial lease/partition policy and the decision sheet (A–G) have been approved by the project owner (DECISIONS.md D49). W9.2 (synchronization implementation) may begin in a dedicated task; it was explicitly out of scope for the task that recorded this approval and has not started.
