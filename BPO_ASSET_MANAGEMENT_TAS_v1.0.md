# BPO Asset Management System
## Technical Architecture Specification (TAS) v1.0

**Document status:** Baseline specification for implementation planning  
**Version:** 1.0  
**Project:** Independent BPO Asset Management System  
**Initial deployment:** One designated Windows computer; fully standalone and offline-capable  
**Technology decision:** Electron + React + TypeScript + SQLite  
**Central server:** Not part of Version 1  
**Future direction:** Optional multi-device synchronization and multi-tenant SaaS in later releases

---

> **Historical status:** This specification describes the superseded standalone Electron/SQLite architecture. For all new cloud/web development, use `BPO_ASSET_MANAGEMENT_TAS_v2.0.md`. Version 1.0 is retained as a reference for the desktop prototype and its historical decisions.

## 1. Purpose

This document converts the agreed business requirements into an implementable technical baseline. It defines the Version 1 architecture, modules, data model, local workflows, security boundaries, backup and recovery, UI structure, testing, and release criteria.


The system will manage IT and facilities assets for one BPO with approximately 500–2,000 employees. It will track assets from procurement and receipt through storage, allocation, transfer, maintenance, return, and disposal.

### 1.1 Core principles

1. **Standalone first:** No cloud account, central server, or internet connection is required for ordinary Version 1 use.
2. **One authoritative local database:** The designated Windows computer holds the live records.
3. **Transactions before visual updates:** The UI must not show a critical change as saved until the local database transaction succeeds.
4. **Complete asset history:** Important assignments, returns, approvals, corrections, and status changes must remain auditable.
5. **Permission-aware workflows:** Application roles control what each user can view and do.
6. **Practical future migration:** Use stable identifiers, migrations, modular business services, and explicit company ownership. Do not implement server sync or SaaS infrastructure prematurely.
7. **No silent data loss:** Errors, failed imports, backup failures, and rejected operations must be visible to users.

### 1.2 Current project decisions

| Area | Decision |
|---|---|
| Organization model | One BPO organization in Version 1 |
| Scale | Approximately 500–2,000 employees; asset count to be confirmed |
| Platform | Windows desktop application |
| UI | Electron + React + TypeScript |
| Local database | SQLite |
| Server/database service | None in Version 1 |
| Offline operation | All supported core workflows execute locally |
| Data entry | Manual entry plus CSV/Excel import where specified |
| Asset targets | Employee, workstation, department, or shared pool/location |
| Asset labeling | Individually identified higher-value assets; configurable bulk tracking for low-cost items |
| Scanning | USB barcode scanner, manual asset ID, and phone QR scanning subject to a local-network feasibility/security spike |
| Approvals | Rules configurable by Super Admin |
| Financial reporting | Acquisition cost and warranty first; depreciation rules pending Finance decision |
| Future direction | Multi-device synchronization and potential multi-tenant SaaS, not implemented in Version 1 |

---

## 2. Scope

### 2.1 Included in Version 1

- Local user accounts, sign-in, role-based permissions, and Super Admin configuration.
- Company profile, departments, employee records, office sites, buildings, floors, rooms, bays, seats, and storage locations.
- Asset categories, models, individually tracked assets, and configurable bulk-tracked item types.
- Asset register, search, filters, unique asset IDs, QR/barcode label generation, and printing.
- Employee, workstation, department, and shared-pool allocation.
- Issue, transfer, return, inspection, and acknowledgment workflows.
- Employee exit clearance and missing/damaged asset exceptions.
- Maintenance tickets, technician assignments, vendor repairs, repair costs, and downtime history.
- Procurement requests, configurable approvals, purchase records, receiving, rejected goods, and registration of received assets.
- Supplier records and invoice/warranty document metadata.
- Physical audits and discrepancy tracking.
- Operational dashboard, reports, CSV export, and printable reports.
- Acquisition-cost and warranty reporting; configurable depreciation fields are designed but depreciation outputs remain disabled until Finance policy is approved.
- Local audit trail, database migrations, database backup/restore, attachment backup, and signed Windows installer.

### 2.2 Not included in Version 1

- Central server, PostgreSQL, remote synchronization, simultaneous multi-computer use, cloud hosting, or web admin portal.
- Multi-tenant customer provisioning, subscription billing, and customer self-service.
- Full general ledger, accounts payable, tax reporting, payroll, HRIS, attendance, workforce management, or contact-centre telephony.
- Software license discovery/metering and remote endpoint management.
- Consumables warehouse accounting for stationery, cleaning supplies, and similar low-value consumable stock.
- AI-based predictive maintenance or automated purchasing recommendations.
- A guarantee that application-level roles can protect local data from a person who has full Windows administrator access to the computer.

### 2.3 Definition of standalone

The installed application stores business data and documents locally. Normal record creation, allocation, maintenance, procurement workflow, approval workflow, reports, and backup operations do not depend on the internet.

The app may use the local network only for the optional paired-phone QR scanning feature. If the phone and designated computer cannot communicate over a local network, phone-to-desktop scanning is unavailable; USB scanning and manual entry remain available.

---

## 3. Technology stack

### 3.1 Selected baseline

| Layer | Baseline choice | Notes |
|---|---|---|
| Desktop shell | Electron | Windows desktop packaging and OS integration |
| UI | React + TypeScript | Component-based typed interface |
| Renderer build | Vite | Fast development server and production bundling |
| Styling/components | Tailwind CSS plus a maintained accessible component library | Keep UI components consistent; avoid custom controls where a reliable component exists |
| Forms and validation | React Hook Form + Zod (or equivalent maintained packages) | Validate inputs in the UI, then validate again in application services |
| Local database | SQLite accessed only from the Electron main process | No renderer-side database access |
| SQLite driver | `better-sqlite3` is the proposed default | Native module; must be rebuilt for the pinned Electron runtime and tested in the packaged installer |
| Database migrations | Versioned SQL migration files, tracked in a schema migration table | Migrations must be forward-safe and backed up before execution |
| QR generation | Bundled QR generation library | QR payload contains a non-secret internal asset identifier only |
| USB scanning | HID/keyboard-wedge input workflow | Most USB scanners type the decoded string as keyboard input; configurable suffix and focus behavior |
| Phone scanning | Small paired scanner page served only by a local app component, gated by a feasibility/security spike | Requires local network connectivity, pairing, short-lived tokens, and a secure camera-access design; not an internet-hosted service |
| Windows installer | electron-builder with a Windows NSIS installer | Include native SQLite module correctly; test installation, upgrade, and uninstall behavior |
| Tests | Vitest or equivalent for unit tests; Playwright for renderer/UI flows where suitable; Electron integration tests | Add real packaged-app smoke tests |

Pin supported versions in the repository lockfile when development starts. Do not use wildcard dependency versions or update Electron/native dependencies without running the packaged-app test suite.

### 3.2 Electron process boundaries

**Main process** owns:
- SQLite connection and query execution.
- Domain/application services.
- Authentication and permission checks.
- File, attachment, import/export, backup, and print-dialog coordination.
- Local phone-scanning service, if enabled.
- Application logging and update/installer integration.

**Preload layer** exposes a small, typed, allow-listed API using `contextBridge`.

**Renderer** owns:
- React screens and presentation state.
- Forms and client-side validation for user experience.
- Displaying operation results and errors.
- No direct Node.js, filesystem, SQLite, arbitrary IPC, or shell access.

Security configuration requirements:
- `nodeIntegration: false` for renderer windows.
- `contextIsolation: true`.
- Renderer sandboxing enabled.
- A restrictive Content Security Policy.
- Block unneeded navigation and new-window creation.
- Validate the sender and payload of IPC requests.
- Expose specific methods such as `assets.search`, not unrestricted `ipcRenderer` or SQL execution.
- Never load arbitrary remote web content in the privileged application window.

### 3.3 Application-service and IPC contract

The renderer communicates through a typed, allow-listed application API exposed by preload. These are logical contracts; final TypeScript DTOs are implemented in `src/shared/` and validated before service execution.

Minimum command groups:
- `session.login`, `session.logout`, `session.getCurrentUser`, `session.lock`.
- `assets.create`, `assets.update`, `assets.getById`, `assets.search`, `assets.generateLabel`.
- `employees.create`, `employees.update`, `employees.importPreview`, `employees.importCommit`.
- `assignments.issue`, `assignments.transfer`, `assignments.return`, `assignments.getHistory`.
- `exitClearance.open`, `exitClearance.recordItem`, `exitClearance.resolveException`, `exitClearance.close`.
- `maintenance.createTicket`, `maintenance.addEvent`, `maintenance.assign`, `maintenance.close`.
- `procurement.createRequest`, `procurement.submit`, `procurement.recordReceipt`.
- `approvals.getQueue`, `approvals.decide`, `approvals.configurePolicy`.
- `audits.create`, `audits.recordScan`, `audits.resolveDiscrepancy`, `audits.close`.
- `reports.run`, `reports.export`.
- `backup.create`, `backup.validate`, `backup.restore`, `settings.get`, `settings.update`.

Contract rules:
- Each request receives a validated DTO; do not accept arbitrary SQL, file paths, or raw object keys from renderer input.
- Mutating operations return the committed record summary and operation ID only after transaction commit.
- Errors use stable application codes such as `VALIDATION_ERROR`, `PERMISSION_DENIED`, `NOT_FOUND`, `STATE_CONFLICT`, `DUPLICATE_RECORD`, `DATABASE_ERROR`, `BACKUP_FAILED`, and `RESTORE_FAILED`.
- Long-running imports, report generation, and backup operations expose progress events or a job ID; they must not freeze the renderer.
- Every mutating service checks the current user's permissions and writes its required audit event within the same database transaction whenever possible.

### 3.4 Repository structure

Suggested project layout:

```text
bpo-asset-management/
  src/
    main/                    # Electron main process
      app/
      auth/
      database/
        migrations/
        repositories/
      services/
      ipc/
      backup/
      import-export/
      scanner/
      logging/
    preload/                 # Narrow, typed API bridge
    renderer/                # React + TypeScript UI
      app/
      components/
      features/
        dashboard/
        assets/
        employees/
        locations/
        allocations/
        exit-clearance/
        maintenance/
        procurement/
        approvals/
        audits/
        finance/
        reports/
        settings/
      routes/
      styles/
    shared/                  # Types, schemas, enums, IPC contracts
  tests/
    unit/
    integration/
    e2e/
    fixtures/
  docs/
  package.json
  lockfile
```

Keep domain rules out of React components. UI components call application-service methods through the typed preload interface.

---

## 4. Local data and filesystem layout

### 4.1 Database location

Use Electron's OS-specific application data path, for example `%APPDATA%/<Company>/<App>/` or a suitably protected `%LOCALAPPDATA%` subdirectory, rather than the install directory or project folder. The final choice should match Windows backup and access requirements.

Suggested structure:

```text
<AppData>/
  database/
    asset-management.sqlite
  documents/
    invoices/
    warranties/
    handovers/
    maintenance/
    audits/
  backups/
    manifest.json
  logs/
```

Documents should be stored as files with generated internal names. Their metadata and relationships live in SQLite. Do not trust user-supplied filenames or paths as storage paths.

### 4.2 SQLite configuration

- Enable foreign-key enforcement on every connection.
- Use parameterized statements only.
- Wrap multi-table operations in transactions.
- Use a busy timeout appropriate for a single local user/database connection.
- Consider WAL mode only if required by the workload and tested with the backup/restore strategy. Keep the database on the local disk; do not put it on a network share.
- Ensure backups account for WAL state by using SQLite's backup mechanism or a coordinated clean-close/checkpoint procedure. Do not copy only the main `.sqlite` file while it may have uncheckpointed WAL transactions.
- Run integrity checks on restore and in a documented diagnostic function.
- Never modify schema outside versioned migrations.

### 4.3 IDs and timestamps

- Use UUIDs for primary keys and externally meaningful record identifiers.
- Separate the human-readable asset code from the primary key; asset codes should be unique and not reused after retirement or disposal.
- Persist timestamps in UTC ISO-8601 format; display them in the configured local time zone.
- Store dates such as purchase date and warranty expiry as date-only values when time-of-day is not meaningful.
- Use integer minor currency units (for example, paise for INR) for money calculations; never use floating-point numbers for monetary totals.
- Use explicit status enums or lookup tables instead of free-form status strings.

### 4.4 Initial company record

Create one organization/company-profile record during first-run setup. The Version 1 UI must not allow users to create a second organization. This gives the data a clear ownership boundary without implementing multi-tenancy.

---

## 5. Modules and screens

### 5.1 Navigation

Primary navigation:
1. Dashboard
2. Assets
3. Employees
4. Locations and workstations
5. Allocations and returns
6. Exit clearance
7. Maintenance
8. Procurement
9. Approvals
10. Physical audits
11. Financial reports
12. Reports and exports
13. Settings and user administration
14. Backup and recovery

Menu items and actions must be permission-aware, but hiding a button is not an authorization control. The service layer must enforce permissions for every action.

### 5.2 Asset register

Required screen capabilities:
- Search by asset ID, serial number, barcode/QR payload, make/model, employee, location, or supplier.
- Filter by category, lifecycle status, operational status, assignment state, location, warranty, and condition.
- Show clear state labels and last-modified information.
- Create/edit records with field-level validation.
- View a detail page with overview, assignment history, maintenance history, procurement details, financial data, documents, audit log, and physical audit status.
- Print/reprint labels while retaining the same asset identity.
- Export the currently authorized search/report result.

### 5.3 Dashboard

Show counts and exceptions derived from live database records:
- Total active assets.
- Assigned, available, under-maintenance, under-inspection, lost, retired, and disposed counts as distinct views.
- Purchase requests awaiting approval.
- Open/overdue maintenance tickets.
- Pending returns and employee exit exceptions.
- Warranties expiring in a configurable window.
- Physical audits in progress and unresolved discrepancies.

Definitions must be documented. An asset awaiting inspection must not be counted as available. Disposed or retired assets must not be counted as active inventory.

### 5.4 Employee and organizational screens

- Employee list, profile, employment status, department, manager, work location, and active asset assignments.
- CSV import preview with column mapping, validation errors, duplicate checks, dry-run, and explicit commit.
- Department, team/process, office site, building, floor, room, bay, workstation/seat, and shared asset pool management.
- Employee deactivation must not delete assignment or audit history.

### 5.5 Allocation screen

- Select target type: employee, workstation, department, or shared pool.
- Scan or search assets, check availability, record condition/accessories, issue date, expected return date where relevant, and notes.
- Create one transaction for a group handover while preserving a distinct asset-assignment record per asset.
- Capture issuer and recipient acknowledgment; an on-screen acknowledgment or attached signed document can be used based on policy.
- Return flow must record receiving person, date, condition, and whether the asset is ready, faulty, or awaiting inspection.

### 5.6 Maintenance screens

- Create ticket from an asset record or a general maintenance queue.
- Record category, description, priority, reported by, assigned technician, vendor, status, target date, diagnosis, work performed, parts/costs, downtime, and closure details.
- Keep each repair as a distinct event/ticket; do not overwrite old service history.

### 5.7 Procurement screens

- Purchase request creation and line items.
- Configurable approval route preview.
- Approval queue and decision history.
- Purchase order/vendor/reference information and receipt workflow.
- Receipt line with ordered, received, rejected, and outstanding quantities.
- Create individually tracked asset records from received items; support partial receipts.
- Attach invoices, quotations, warranties, and receiving evidence.

### 5.8 Exit clearance

- Open clearance for an employee and expected exit date.
- Automatically list all currently assigned assets for which the employee is custodian, including any explicit asset relationship required by policy.
- Record each item as returned, outstanding, disputed, damaged, missing, or exception-approved.
- Require inspection and disposition decision where applicable.
- HR can view overall clearance status, while restricted IT/financial details remain permission-controlled.
- Final closure requires all required items resolved or an authorized exception with reason/evidence.

### 5.9 Physical audit screens

- Create audit by site, floor, category, custodian, or selected inventory subset.
- Capture expected and observed location/condition, scanner operator, timestamp, and discrepancy type.
- Avoid altering asset records automatically just because a scan differs; create a discrepancy for review.
- Close an audit only after discrepancies are resolved or formally accepted by an authorized role.

---

## 6. Business roles and permission model

The Super Admin configures which named users or roles can perform actions. Default roles are templates, not immutable business rules.

| Role | Baseline permissions |
|---|---|
| Super Admin | Local user management, role and approval configuration, company settings, backup/restore controls; cannot erase audit history through normal UI |
| Asset Manager | Asset register, allocation, transfers, returns, stock, labels, physical audits |
| IT Support / Technician | IT asset maintenance, ticket work, inspection findings, service history |
| Facilities Manager | Facilities assets, locations, movement, and maintenance |
| Procurement Officer | Purchase requests, supplier records, orders, receiving, procurement documents |
| Department/Process Manager | Requests and approvals within configured scope |
| HR Officer | Employee lifecycle, exit clearance coordination, clearance status |
| Finance Officer | Purchase costs, depreciation settings/reports when enabled, disposal financial records |
| Auditor | Read-only register/history/reports and audit evidence |
| Employee/Agent | View relevant assigned assets, acknowledge issue/return, report a fault if the policy permits |

### 6.1 Permission actions

Use explicit permission keys such as:
- `assets.view`, `assets.create`, `assets.update`, `assets.retire`, `assets.dispose`.
- `allocations.issue`, `allocations.transfer`, `allocations.return`, `allocations.override`.
- `procurement.create`, `procurement.submit`, `procurement.approve`, `receipts.record`.
- `maintenance.create`, `maintenance.assign`, `maintenance.close`.
- `finance.view_cost`, `finance.configure_depreciation`, `finance.approve_adjustment`.
- `users.manage`, `roles.manage`, `approvals.configure`, `backup.create`, `backup.restore`.

### 6.2 Separation of duties

- A user should not approve their own purchase request unless Super Admin explicitly enables and documents an exception.
- Disposal/write-off must require an authorized role different from the requester where practical.
- Auditor role is read-only.
- Role changes and approval-policy changes must create audit events.
- Restore operations must require explicit confirmation and create a local administrative log where possible.

### 6.3 Local authentication limitation

Application logins and RBAC protect routine use. They do not provide strong protection against someone with full local Windows administrator access who can copy or replace application files or database data. The deployment owner must protect the Windows account, enable full-disk encryption (such as BitLocker where available), and control administrator access.

Store password hashes using a modern password-hashing approach with per-user salts and appropriate work factors; never store plain-text passwords. Apply idle session locking, attempt throttling, and an explicit sign-out action. The application must not require internet connectivity to authenticate local users.

---

## 7. Domain model and lifecycle rules

### 7.1 Separate status dimensions

Do not collapse all asset states into one large status enum. Store distinct lifecycle and operational states; derive assignment state from active assignment records.

**Lifecycle status:** `active`, `retired`, `disposed`, `lost` (the exact transition rules must be enforced by services).  
**Operational status:** `ready`, `under_maintenance`, `non_operational`, `awaiting_inspection`.  
**Assignment state:** derived as `assigned` when an active assignment exists; otherwise `unassigned`.  
**Condition:** `new`, `good`, `fair`, `damaged`, `unknown`.

An asset is eligible for issue only when its lifecycle status is `active`, operational status is `ready`, no active assignment exists, and no policy hold blocks issue. Do not store an independently editable `available` flag that can contradict the other fields.

### 7.2 Assignment targets

An assignment may target exactly one of:
- Employee.
- Workstation/seat.
- Department/team.
- Shared asset pool.

Physical location is stored separately from assignment target. An asset can be assigned to an employee but physically located at an office/site/seat.

The assignment record must preserve the start and end dates, issuer, recipient/target, location at issue, condition at issue/return, acknowledgment evidence, and reason for transfer/return.

### 7.3 Immutable or append-only history

Do not edit historical assignments into current state. Close the old assignment and create a new assignment/transfer transaction. For erroneous transactions, record a correction/reversal with a reason and actor rather than deleting history.

Important events include asset create/update, issue, transfer, return, inspection, maintenance status change, procurement submit/approve/reject, receipt, exit-clearance action, audit discrepancy, retirement/disposal, role change, policy change, import, export where security-relevant, backup, and restore.

---

## 8. Proposed database schema

This is the baseline logical schema. Exact column types, indexes, and migrations should be authored and reviewed before implementation. All primary keys use UUID strings or 16-byte UUIDs consistently; never mix formats in a table family. Tenant-owned root/business tables include `organization_id` as described above; child ownership must be validated through parent relationships.

### 8.1 Organization and identity

**`organization_profile`**
- `id` (PK, exactly one row in Version 1)
- `legal_name`, `display_name`, `base_currency`, `timezone`, `address_json`
- `created_at`, `updated_at`

**Tenant ownership convention for future migration:** Every tenant-owned root/business table should carry `organization_id` referencing `organization_profile` now where practical (including users, employees, departments/teams, locations, categories, models, suppliers, assets, procurement requests, and maintenance/audit root records). Child rows may inherit organization ownership through a parent foreign key if the service and database constraints make that relationship unambiguous. Version 1 enforces exactly one organization and does not implement tenant switching or tenant isolation. The renderer must never choose an arbitrary organization ID; it is determined by local configuration.

**`users`**
- `id` (PK), `username` (unique, normalized), `display_name`, `password_hash`, `is_active`
- `last_login_at`, `must_change_password`, `created_at`, `updated_at`

**`roles`**, **`permissions`**, **`user_roles`**, **`role_permissions`**
- Normalized many-to-many access control with unique constraints on relationship pairs.

**`departments`**, **`teams`**
- Department/team name, optional code, manager link, active flag, timestamps.

**`employees`**
- `id` (PK), `employee_code` (unique), name, email/phone where required, department/team, manager, joining date, expected/actual exit date, employment status, notes, timestamps.
- Keep minimum necessary personal data. Employee deactivation does not delete history.

### 8.2 Locations

**`locations`**, **`workstations`**, **`asset_pools`**
- Use one `locations` table with `parent_location_id`, `location_type` (site/building/floor/room/bay/seat/storage/other), code/name, active status, and timestamps to represent the physical hierarchy.
- `workstations` are separate records linked to a relevant location and hold a unique workstation/seat code within the defined scope.
- `asset_pools` represent shared custody groups and may reference a default location.
- Departments/teams are organizational units, not physical locations. Do not represent a seat as an employee.

### 8.3 Asset catalogue and inventory

**`asset_categories`**
- Name/code, description, tracking mode (`individual` or `bulk`), required fields policy, default lifecycle policy, active flag.

**`asset_models`**
- Category, manufacturer, model name/number, specifications, active flag.

**`suppliers`**
- Supplier name/code, contact details, address, tax/legal reference if required, active flag, notes.

**`assets`** (individually tracked)
- `id` (UUID PK), `organization_id`, `asset_code` (unique, never reused), `category_id`, `model_id`, manufacturer/model snapshot, serial number, barcode/QR payload, purchase/receipt linkage, acquisition date, acquisition cost in minor units, currency, supplier, invoice reference, warranty start/end, lifecycle status, operational status, condition, current physical location, purchase source, notes, created/updated timestamps. The current assignment is derived from `asset_assignments`; do not duplicate an independently editable assignment target on the asset row.
- Serial number uniqueness should be configurable by category and manufacturer; avoid making an empty serial globally unique.
- The current active assignment should be derived/validated against assignment records, not independently mutated without a transaction.

**`bulk_stock_items`**
- For categories approved for quantity tracking only: category/model, supplier or receipt source, location, quantity received, quantity available, unit cost, condition, and timestamps.
- Every quantity change must create a `stock_movements` row; never update stock quantity without a corresponding movement transaction.
- Bulk-tracked items cannot be used where individual custody, serial traceability, or high-value asset history is required.

**`documents`**, **`document_links`**
- `documents`: document ID, relative storage key, original display name, MIME type, byte size, checksum, uploaded-by user, created timestamp.
- `document_links`: document ID, owning entity type/ID, relationship purpose (invoice, warranty, handover, repair evidence, audit evidence, etc.).
- Because links may target several business entity types, the service layer must validate that each owner exists and is allowed; automated tests must detect orphaned links. Store files outside the database and use generated storage keys, never user-provided paths.

### 8.4 Assignment, transfer, and acknowledgment

**`asset_assignments`**
- `id`, `organization_id`, `asset_id`, assignment target type, exactly one target foreign key (`employee_id`, `workstation_id`, `department_id`, or `asset_pool_id`), physical `location_id`, `assigned_at`, `expected_return_at`, `returned_at`, issuer user, recipient acknowledgment name/user, condition-at-issue, condition-at-return, status, reason, notes, created timestamp.
- Assignment status values should be explicit, e.g. `active`, `returned`, `transferred`, `cancelled`; transitions must be validated by the service.
- Add a database-level or transactionally enforced invariant allowing at most one active assignment per asset.
- Add a CHECK constraint so exactly one target FK matches the target type.

**`asset_movements`**
- Asset ID, movement type, from/to assignment or location, movement date, reason, actor, related transaction ID, notes.
- Movement history is append-only under normal operation.

**`stock_movements`**
- Bulk stock item ID, quantity delta, movement type, from/to location, related receipt/issue/return/adjustment, actor, timestamp, reason.
- On-hand quantities must reconcile to the sum of stock movements or be protected by a documented transactional balance mechanism.

### 8.5 Procurement and approvals

**`purchase_requests`**, **`purchase_request_items`**
- Request number, requester, department, justification, needed-by date, estimated amount in minor currency units, currency, status, submitted/closed timestamps.
- Line items: category/model or description, quantity, estimated unit price, line total, notes.

**`purchase_orders`**, **`purchase_order_items`**
- Supplier, PO number, related approved request where applicable, dates, currency, order totals, status, external reference, document metadata.

**`goods_receipts`**, **`goods_receipt_items`**
- Purchase order, receipt number/date, receiver, ordered/received/rejected/outstanding quantity, inspection outcome, discrepancy note, document references.
- Partial receipts must be supported.

**`approval_policies`**, **`approval_policy_steps`**
- Entity/action type, amount thresholds where applicable, order of approval, required role or specified approver, conditions, active state, version, and policy author.

**`approval_instances`**, **`approval_decisions`**
- Entity type and target ID, a snapshot/version of the policy selected at submission, current status, step order, approver, decision, comments/reason, actor, and timestamps.
- Since SQLite cannot define a normal foreign key to multiple different target tables through a polymorphic target, the service layer must enforce that each approval target exists and is of an allowed type. Add tests to prevent orphan approvals.
- Do not retroactively change an in-flight approval path when the Super Admin edits a policy; snapshot the applied policy or its version at submission.

### 8.6 Maintenance

**`maintenance_tickets`**
- Ticket number, asset ID or bulk item reference, reporter, assigned technician, fault category, description, priority, status, reported timestamp, target resolution, diagnosis, resolution notes, downtime start/end, vendor, parts cost, labor/service cost, total cost, closure actor/date.

**`maintenance_events`**
- Ticket ID, event type, old/new status, notes, author, timestamp, optional document references.
- Preserve ticket history and comments as separate events.

### 8.7 Exit clearance and audit

**`exit_clearances`**
- Employee ID, exit date, status, created by, opened/closed timestamps, closing authority, overall notes.

**`exit_clearance_items`**
- Clearance ID, asset ID or bulk-stock item/quantity reference where appropriate, expected item, resolution status, received condition, exception reason, evidence/document reference, reviewed by, timestamp.

**`physical_audits`**, **`physical_audit_items`**
- Audit scope, date, status, owner, generated expected asset set, scanned/verified status, observed location/condition, discrepancy type, evidence, assignee, resolution, reviewer, timestamps.

### 8.8 Finance, configuration, audit, and system

**`asset_financial_profiles`**
- Asset ID, acquisition cost, capitalizable costs if tracked, residual value, useful life months, depreciation method, depreciation start date, financial classification, policy version, optional disposal proceeds.
- Depreciation fields are nullable until Finance approves the policy. Do not produce accounting-grade depreciation reports while required policy fields are missing.

**`app_settings`**
- Strictly allow-listed key/value settings; do not use it as a dumping ground for arbitrary business records.

**`audit_events`**
- ID, actor user ID where known, event type, entity type/ID, timestamp, reason, transaction/correlation ID, and structured before/after summary with sensitive data redacted.
- Do not store passwords, credentials, or full sensitive document contents in audit payloads.
- Normal UI must not support audit-event deletion or editing.

**`schema_migrations`**
- Version, migration name/checksum, applied timestamp, app version, success marker where appropriate.

**`backup_history`**
- Backup ID, creation time, file path/relative target, checksum, database schema version, attachment manifest, result/status, and actor/automatic job indicator.

### 8.9 Database constraints and indexes

At minimum:
- Unique indexes on asset code, employee code, normalized username, role/permission relationship pairs, and purchase/ticket number.
- Index asset category, lifecycle/operational status, location, serial number, warranty end, assignment target, and active assignment lookups.
- Foreign keys enabled on every connection.
- `CHECK` constraints for nonnegative quantities/costs where appropriate, valid enum values, and exactly-one-target relationships.
- Transactionally enforce one active assignment per asset.
- Make identifiers stable and never recycle an old asset code.
- Validate important rules at the service layer even where the database constraint is also present.

---

## 9. Core workflows and invariants

### 9.1 Procure to receive

1. Requester creates a purchase request with line items and justification.
2. System resolves the applicable approval policy and snapshots its version.
3. Authorized approvers decide in the configured order; each decision is logged.
4. Approved request may be converted into a purchase order/record.
5. Receiver records partial/full receipt, rejects, discrepancies, and supporting documents.
6. Individually tracked goods become asset records; quantity-managed goods become bulk stock records.
7. Reconcile receipt totals and order status.

Invariant: Approval is not the same as receipt. Assets cannot be issued before the required registration and receiving conditions pass.

### 9.2 Issue and return

1. Select the assignment target and location.
2. Scan/search each asset and validate its lifecycle/operational/assignment state.
3. Capture issue condition, actor, recipient/target, expected return date if relevant, and acknowledgment.
4. Commit assignment and movement history in one transaction.
5. On return, close the active assignment and record return condition and inspection state in one transaction.
6. Faulty/inspection-required assets are not considered available.

Invariant: At most one active assignment exists per individually tracked asset. A failed database transaction must not leave a half-created assignment or movement.

### 9.3 Employee exit clearance

1. Open clearance for the employee.
2. Generate the list of expected assets from active assignments and policy-defined custody links.
3. Receive and inspect each asset; close its assignment when physically returned.
4. Record missing, damaged, disputed, or otherwise unresolved items as exceptions.
5. Require an authorized decision to close each exception.
6. Close clearance only if all required items are resolved or a permitted exception has been approved.

Invariant: Deactivating an employee never automatically marks assets as returned.

### 9.4 Maintenance

1. Create a ticket linked to an asset.
2. Assign priority and technician; record target date.
3. Move asset to the appropriate operational state when service requires it to be unavailable.
4. Add diagnosis, actions, vendor, parts, labor, costs, downtime, and documents as events.
5. Close the ticket with outcome and authorized return-to-service decision.

Invariant: Closing a ticket does not itself make an asset available if another condition/assignment constraint blocks it.

### 9.5 Physical audit

1. Define audit scope and generate the expected list.
2. Scan or verify assets.
3. Compare expected and observed identity/location/condition.
4. Create discrepancies; do not silently update the master record.
5. Review evidence and resolve discrepancies through normal asset-change transactions.
6. Close the audit with a retained summary and outstanding-exception list if policy permits.

### 9.6 Import from CSV/Excel

1. User selects a file through a native file picker.
2. The app previews columns and sample rows.
3. Validate required fields, duplicates, references, date formats, money formats, and category-specific fields.
4. Show row-level errors and allow correction/re-upload.
5. Show a dry-run summary: creates, updates (if enabled), skipped rows, and errors.
6. Commit only after explicit confirmation.
7. Record import metadata and summary in the audit log.

Never ingest spreadsheet formulas as executable logic. Export untrusted cell values safely to reduce spreadsheet formula injection risk.

---

## 10. QR/barcode scanning and labels

### 10.1 QR/barcode payload

Use an opaque non-secret identifier, for example `BPOAM:ASSET:<uuid>`. Do not embed employee personal data, purchase price, passwords, or unrestricted file paths in the code. The application resolves the identifier locally.

The human-readable asset code must also be printed on each label for manual fallback.

### 10.2 USB scanner

- Treat common USB scanners as keyboard-wedge devices.
- Provide a dedicated scan field that can remain focused during bulk scanning.
- Allow scanner suffix configuration (Enter/Tab/none) and test common scanner settings.
- Validate the decoded payload before invoking a privileged operation; scanning must not automatically issue or return an asset without the user confirming the transaction.

### 10.3 Manual ID entry

- Search by asset code or serial number.
- Validate exact matches and show a confirmation view before state-changing operations.
- Avoid selecting the first fuzzy match for issue/return operations without confirmation.

### 10.4 Phone camera scanning

The business requirement is phone QR scanning, but it is not automatically available in a standalone desktop app. Implement only after a small proof of concept establishes a secure, reliable local-network path.

Proposed direction: the desktop starts a temporary local pairing endpoint; the desktop displays a short-lived pairing QR; a phone on the same trusted local network opens a minimal scanner page and receives a short-lived session token. The page can submit scanned opaque asset IDs to the desktop session, but cannot run SQL or perform privileged operations. The desktop user confirms each state-changing operation.

Security/feasibility gates:
- Do not expose the local endpoint to the public internet.
- Require pairing, short token lifetime, expiry, and explicit revoke/close.
- Validate Origin/Host and every payload; rate-limit requests.
- Do not accept arbitrary commands from the phone.
- Use a secure camera context; if the TLS/trust setup proves too burdensome, defer phone scanning and ship USB + manual scanning rather than weaken browser security.
- Phone scanning requires local network connectivity, even though internet is not required.

---

## 11. Approvals and policy configuration

The Super Admin configures:
- Which transaction types require approval.
- Approval thresholds by amount where applicable.
- Ordered approval steps.
- Required roles or named approvers.
- Whether requester/approver separation is mandatory.
- Who can approve exceptions, disposal, write-off, or overrides.

The system must validate approver authority at decision time. A UI button is not sufficient. The exact approval policies and dollar/rupee thresholds are business configuration, not code constants.

For Version 1, implement a manageable workflow engine for the required transaction types. Do not build an unrestricted general-purpose BPM engine.

---

## 12. Finance and depreciation

Finance requirements are not yet decided.

### 12.1 Version 1 baseline

Implement:
- Acquisition cost and currency.
- Supplier and invoice references.
- Purchase/acquisition date.
- Warranty start/end.
- Maintenance and repair costs.
- Disposal date/proceeds where relevant.
- Reports of original cost, repair costs, and warranties.

### 12.2 Deferred output

Do not present depreciation or net book value as authoritative until Finance confirms:
- Depreciation method(s), such as straight-line or other required method.
- Useful life by category/asset class.
- Residual/salvage value policy.
- Depreciation start convention (purchase, in-service, or other date).
- Proration rules and rounding rules.
- Currency and treatment of tax/installation costs.
- Whether management reporting and official accounting schedules should differ.

Store nullable financial policy fields now, but leave depreciation reporting disabled or clearly marked as not configured until the policy is approved. Financial calculations require automated test cases against Finance-approved examples.

---

## 13. Backup, restore, and data portability

### 13.1 Backup requirements

- Provide manual backup on demand and configurable automatic backup (daily recommended as the initial default).
- Support a backup destination separate from the live database disk where practical: external drive or approved protected location.
- Back up SQLite using a consistency-safe method; account for WAL state and open transactions.
- Include documents/attachments and a manifest with checksums, schema version, app version, database backup time, and counts.
- Retain multiple generations; never overwrite the only known-good backup.
- Show backup result, timestamp, destination, and errors in the UI.
- Do not include logs or backup files recursively inside each other.

### 13.2 Restore requirements

- Restore must be an explicit privileged operation with a confirmation dialog.
- Create a pre-restore safety backup when possible.
- Validate backup manifest, checksums, schema compatibility, and database integrity before replacing live data.
- Restore database and related document files as a coordinated set.
- Reopen the database and run integrity/foreign-key checks.
- Record restore details in a local administrative log. Explain that restore may replace current data.

### 13.3 Recovery target

Initial business target to confirm with the BPO: maximum tolerable data loss of one business day if the computer disk fails (daily backup), with restoration to a replacement Windows computer. This is a proposed target, not a guarantee, until backup media and restore tests are defined.

### 13.4 Export and future migration

Provide export/import paths for assets, employees, assignments, supplier data, and financial history. Also provide a full backup/restore package. CSV export alone is not a complete migration strategy because documents and linked history must be retained.

---

## 14. Application logging, errors, and data integrity

- Use structured logs with timestamp, severity, subsystem, correlation ID, and safe diagnostic context.
- Do not log passwords, tokens, or unnecessary employee personal data.
- Display user-friendly errors with a reference/correlation ID; preserve technical detail in protected local logs.
- Distinguish validation errors, permission errors, database/transaction failures, import failures, and backup/restore failures.
- Never show success before the relevant transaction commits.
- If a critical write fails, keep the form data where safe and offer retry/cancel.
- Use transactions for allocation/return, purchase receipt, stock adjustment, approval decision, and audit resolution workflows.
- Back up before schema migration and fail safely if migration cannot complete.

---

## 15. Performance and reliability targets

These are initial targets to validate against realistic test data, not promises about unmeasured performance.

- Search common asset records: target under 2 seconds on the designated computer with realistic test data.
- Open asset detail pages: target under 2 seconds excluding slow external file operations.
- Common local transactions: target under 2 seconds under normal conditions.
- Import preview: report progress and errors; do not freeze the whole window for large files.
- Reports over large datasets: run in bounded background work or paginated operations so the UI stays responsive.
- Data operations must be atomic where multiple records must change together.
- App startup must detect an inaccessible/corrupt database and offer a guided recovery path rather than silently creating a blank database over existing data.

Test against an agreed sample volume. Employee count alone does not define asset database size; the test fixture should include multiple years of assignment, maintenance, and audit history.

---

## 16. Testing and acceptance criteria

### 16.1 Required test layers

**Unit tests:** Status transitions, permission evaluation, approval routing, depreciation calculation once enabled, money rounding, import validation, QR parsing, availability rules.

**Database/integration tests:** Foreign keys, unique indexes, active-assignment invariant, transactions/rollbacks, migrations, receipt calculations, stock movements, backup/restore, and orphan approval prevention.

**UI/end-to-end tests:** Login, asset create/edit/search, issue/return, purchase approval, goods receiving, maintenance ticket lifecycle, exit clearance, physical audit, reporting, and backup/restore confirmation.

**Packaging tests:** Install on a clean supported Windows environment, launch, create data, close/reopen, update, uninstall/reinstall while preserving or intentionally retaining user data according to policy, and test SQLite native module loading inside the packaged app.

**Security checks:** IPC allow-list, sender validation, restrictive Content Security Policy, blocked unexpected navigation, no renderer Node access, role bypass attempts, invalid file paths, malicious import data, and phone pairing if implemented.

### 16.2 Release acceptance checklist

- [ ] The app installs and launches on the supported Windows version without requiring internet.
- [ ] A first-run setup creates one organization profile and the initial Super Admin.
- [ ] Users can create/edit/search assets and print identifiable labels.
- [ ] CSV/Excel employee import has preview, duplicate checks, row errors, and confirmation before commit.
- [ ] Assets can be assigned to employees, workstations, departments, and shared pools.
- [ ] The database prevents two simultaneous active assignments of one individually tracked asset.
- [ ] Return/inspection history is preserved and a returned faulty asset is not shown as available.
- [ ] Exit clearance lists all expected assets and cannot be silently closed with unresolved items.
- [ ] Purchase requests use the configured approval policy and retain decision history.
- [ ] Partial goods receipt and discrepancies are represented accurately.
- [ ] Maintenance tickets retain chronological service history and costs.
- [ ] Physical audits create discrepancy records and do not silently overwrite asset master data.
- [ ] Cost and warranty reports reconcile to underlying records.
- [ ] Depreciation remains disabled/unconfigured until Finance policy and test cases are approved.
- [ ] Critical business actions create audit events with actor/time/entity.
- [ ] Backup and full restore, including attachments, has been tested on a replacement folder or computer.
- [ ] The app identifies a database/integrity error and does not silently initialize an empty database over existing data.
- [ ] USB scanning and manual entry work. Phone scanning is released only if its local-network security spike passes.
- [ ] Packaged Electron build passes the IPC, sandbox, dependency and native SQLite smoke tests.

---

## 17. Implementation roadmap

### Milestone 0 — Technical spike and setup

- Create the Electron + React + TypeScript scaffold.
- Package a minimal Windows build.
- Prove SQLite access from the Electron main process in both development and packaged builds.
- Prove database migration and backup/restore flow.
- Run a small feasibility test for phone scanning over the local network; do not let that experiment delay the core app.

**Exit criteria:** Packaged app can create, query, migrate, back up, and restore a local database reliably.

### Milestone 1 — Foundation and identity

- App shell, navigation, theme, local user login, roles/permissions, settings, logging, schema migration system, organization profile.
- Department/location hierarchy and employee create/import.

**Exit criteria:** User/role boundaries and reference records pass tests.

### Milestone 2 — Core asset register

- Categories, models, suppliers, assets, documents, search/filter, asset detail, label printing, USB scanner and manual entry.
- Initial dashboard and asset register reports.

**Exit criteria:** Asset register is usable and data can be backed up/restored.

### Milestone 3 — Allocation and exit clearance

- Assignment targets, issue, transfer, return, inspection, acknowledgments, employee clearance, exception process.

**Exit criteria:** No duplicate active assignment; complete auditable handover cycle.

### Milestone 4 — Maintenance and physical audit

- Maintenance tickets/events/costs, condition/state transition rules, audit sessions, discrepancy handling.

**Exit criteria:** Maintenance and physical verification produce complete traceable history.

### Milestone 5 — Procurement and approvals

- Requests, approval policies and steps, purchase orders/records, receipt, partial receipt, and asset creation from receipts.

**Exit criteria:** Super Admin can configure and test the approved business workflows; no self-approval where prohibited.

### Milestone 6 — Finance, reports, and production hardening

- Acquisition cost and warranty reports, configurable future depreciation fields, full report set, export security, backup scheduler, recovery workflow, polished UX, performance and security testing.

**Exit criteria:** All release acceptance criteria pass; Finance has approved whether depreciation is enabled.

### Milestone 7 — Pilot and release

- Import reconciled baseline inventory, train the asset team, test restore, run pilot, resolve defects, sign and publish installer, publish user/admin guide.

**Exit criteria:** BPO owner signs off the inventory baseline, backup process, permissions, and key handover/clearance workflows.

---

## 18. Future phase: multi-device synchronization and SaaS

Not part of Version 1. Preserve the following low-cost design qualities now:
- UUID primary keys and stable asset codes.
- Explicit organization ownership profile.
- Versioned schema migrations.
- Business services separated from UI and persistence details.
- Timestamped and auditable transactions.
- Document manifest/checksum support.
- Exportable records and attachments.

When future multi-device synchronization is approved, design and implement a central API and server database as a separate phase. Required work will include local operation IDs, idempotency, incremental sync, conflict handling, authorization revalidation, tenant isolation, migration, and cross-device conflict testing. Do not claim that Version 1 provides those capabilities.

If two clients can work offline later, concurrent issue/return conflicts are unavoidable unless certain operations are restricted while offline. The future design must represent “locally saved, pending server confirmation” separately from “centrally confirmed”.

---

## 19. Decisions still open

These items are not blockers for the baseline standalone app, but must be resolved before the affected feature ships:

1. **BPO company name, base currency and time zone:** configure during first-run setup; INR may be chosen if appropriate for the organization.
2. **Asset code format:** agree prefix/sequence presentation; internal primary IDs remain UUIDs.
3. **Bulk tracking categories:** specify which low-value items may be quantity-managed.
4. **Phone QR scanning:** complete secure local-network proof of concept; otherwise ship USB + manual in the first release and phone scanning in a follow-up release.
5. **Approval rules:** Super Admin will configure approvers and thresholds; initial starter templates need business confirmation.
6. **Finance policy:** methods, useful lives, residual values, start dates, and rounding rules before depreciation report activation.
7. **Backup policy:** destination, retention count, and maximum tolerable data loss; test recovery to another Windows computer.
8. **Windows baseline:** define supported Windows editions/versions and whether the installer is per-user or per-machine.
9. **Acknowledgment method:** in-app acknowledgment, printed form, or attached signed evidence.
10. **Asset inventory baseline:** agree import template, required fields, serial-number quality, and physical verification process.

No further technology-stack choice is needed to begin Milestone 0.

---

## 20. Definition of planning completion

Planning is sufficiently complete to begin implementation when:
- This TAS has been reviewed and approved by the BPO owner.
- The asset code format, asset categories, initial locations, and bulk-tracking policy are agreed.
- Initial roles and approval templates are agreed.
- A sample set of assets/employees is available for import testing.
- Finance has decided whether depreciation is deferred (recommended) or specified enough policy for implementation.
- The backup destination and restore test owner are agreed.
- The phone scanning feasibility result is recorded, with USB and manual scan support retained regardless.

**Recommendation:** Approve this specification as the Version 1 technical baseline, then start Milestone 0. Do not build server synchronization, cloud hosting, or SaaS billing into the first release.

---

## References

The following official or primary documentation should be consulted when implementing the relevant areas. Pin supported dependency versions at project start rather than copying unversioned examples blindly.

- Electron security recommendations: https://www.electronjs.org/docs/latest/tutorial/security
- Electron process model and preload: https://www.electronjs.org/docs/latest/tutorial/process-model
- Electron IPC guidance: https://www.electronjs.org/docs/latest/tutorial/ipc
- Electron sandbox: https://www.electronjs.org/docs/latest/tutorial/sandbox
- SQLite write-ahead logging and local-host limitation: https://www.sqlite.org/wal.html
- SQLite Online Backup API: https://sqlite.org/backup.html
- better-sqlite3 API: https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md
- better-sqlite3 packaging/Electron troubleshooting: https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md
- electron-builder NSIS packaging: https://www.electron.build/v26/docs/nsis/
- React TypeScript guidance: https://react.dev/learn/typescript
