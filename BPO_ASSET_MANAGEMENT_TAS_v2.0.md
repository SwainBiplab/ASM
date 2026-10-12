# BPO Asset Management System
## Technical Architecture Specification (TAS) v2.0

**Document status:** Updated cloud architecture baseline; implementation is in progress  
**Version:** 2.0  
**Project:** Independent BPO Asset Management System  
**Initial customer model:** One BPO organization  
**Expected scale:** Approximately 500–2,000 employees; asset count and concurrency to be confirmed  
**Target application:** Browser-based, multi-user web application  
**Frontend:** React + TypeScript  
**Backend:** Fastify + TypeScript, using parameterized plain SQL  
**Database:** PostgreSQL  
**Document storage:** S3-compatible object storage behind a storage abstraction  
**Hosting target:** Containerized application + managed PostgreSQL + S3-compatible storage; provider and region undecided  
**Future direction:** Potential multi-tenant SaaS, after an explicit tenant-isolation and operating model review

> **Source-of-truth rule:** This document is the authoritative technical specification for new cloud/web development. `BPO_ASSET_MANAGEMENT_TAS_v1.0.md` is retained as the historical specification for the Electron/SQLite desktop prototype. Do not implement new cloud features by following obsolete v1.0 desktop instructions.

---

## 1. Purpose and project context

The BPO Asset Management System manages the lifecycle of physical IT and facilities assets for a BPO, from procurement and receipt through registration, storage, allocation, movement, maintenance, return, physical audit, and disposal.

The product is changing from a single-computer Electron application to a cloud-based web application because authorized users across IT, HR, Facilities, Procurement, Finance, audit, and management need to work with shared, current records from different computers.

The initial release serves one BPO organization. The design should keep organization ownership explicit so multi-tenant SaaS can be considered later. Tenant billing, customer self-service, and a full SaaS control plane are not in the initial release.

### 1.1 Core principles

1. **One authoritative server:** PostgreSQL behind the central API holds shared business records.
2. **Server-side authorization:** Every protected operation is authorized and validated on the backend; hiding a UI control is not security.
3. **Transactions before success responses:** A critical operation is not reported as successful until the server transaction commits.
4. **Complete history:** Assignments, returns, approvals, corrections, lifecycle changes, and other important events remain auditable.
5. **Provider-neutral deployment:** Avoid cloud-provider lock-in where it does not impose unnecessary complexity.
6. **Security by default:** Enforce least privilege, safe document handling, protected sessions, and careful logging.
7. **No silent data loss:** Import errors, failed transactions, migration problems, and failed backups must be detectable and diagnosable.
8. **Incremental migration:** Preserve the working desktop prototype and reuse valid domain logic, types, validation, UI components, and tests where appropriate; do not blindly port desktop-only infrastructure.
9. **No premature distributed systems:** Use a single modular application and central API. Do not introduce microservices, Kubernetes, or message brokers without a demonstrated need.
10. **Explicit uncertainty:** Unresolved business and deployment decisions remain documented rather than being turned into silent assumptions.

### 1.2 Current project state (reported; verify repository before acting)

| Phase / commit | Reported status | Notes |
|---|---|---|
| Desktop M1–M3: `5ebaa7b`, `471ea57`, `3e13749` | Committed prototype | Retained as reference; Electron/SQLite implementation is not the target architecture for new cloud development. |
| W0: `b95545a` | Cloud architecture documentation | `docs/ARCHITECTURE_V2_CLOUD.md`; decisions D24–D31 were reported. |
| W1: `bd360bb` | Server foundation committed | Fastify, PostgreSQL migrations, server-side sessions, authentication and request protections; see repository status and tests for current truth. |
| Standalone M4 branch: `2b9556f` on `wip/m4-standalone-sqlite` | Partial, non-compiling work, retained off `master` | Do not merge blindly. Some shared allocation types may be reusable after review. |
| W2 | Next/current planned implementation phase | Port organization, employee, catalogue, asset, document, label, scan and export capabilities to PostgreSQL/API. Verify before assuming started or complete. |
| W3 | Planned | Connect browser UI to real APIs and validate complete user workflows. |
| W4 | Planned | Rebuild allocation, transfers, returns, acknowledgments and employee exit clearance on the cloud architecture. |

This table is a snapshot based on reported project updates, not a substitute for inspecting Git and `PROJECT_STATUS.md`.

---

## 2. Scope

### 2.1 Included in the cloud Version 1 target

- Browser-based application accessible from authorized computers and compatible mobile browsers.
- Central authentication, server-side sessions, user management, roles, permissions, and Super Admin configuration.
- One BPO organization with departments, teams/processes, employees, managers, office sites, buildings, floors, rooms, bays, storage areas, workstations/seats, and shared asset pools.
- Asset categories, models, suppliers, individually tracked assets, and configurable bulk-tracked item types where approved.
- Asset register, search, filters, stable IDs, human-readable asset codes, QR/barcode labels, label printing, USB scanner support, and manual ID lookup.
- Employee, workstation, department/team, and shared-pool allocation; issue, transfer, return, inspection, and handover acknowledgment.
- Employee exit clearance and missing/damaged/disputed asset exceptions.
- Maintenance tickets, technician assignments, vendor repairs, costs, downtime, and service history.
- Procurement requests, configurable approvals, purchase orders/records, receiving, partial receipts, rejects/discrepancies, and asset registration from received goods.
- Supplier, invoice, quotation, warranty and supporting document metadata.
- Document upload, authorized download, and attachment links to approved business entities.
- Physical asset audits and discrepancy tracking.
- Dashboard, operational reports, CSV import/export, and printable reports.
- Acquisition-cost, warranty, maintenance-cost, and disposal reporting; depreciation output stays disabled until Finance policy is approved.
- Server-side audit trail, versioned PostgreSQL migrations, managed database backups, object-storage durability controls, and tested recovery procedures.
- A provider-neutral containerized deployment approach.

### 2.2 Not in the initial release unless separately approved

- Full offline transaction processing or multi-device offline synchronization.
- Multi-tenant customer provisioning, tenant billing, subscription management, and customer self-service.
- Full general ledger, accounts payable, tax filing, payroll, HRIS, attendance, workforce management, or contact-centre telephony.
- Software-license discovery/metering and remote endpoint management.
- Consumables warehouse accounting for stationery, cleaning supplies, and similar consumable stock unless later added to scope.
- AI-based predictive maintenance or autonomous purchasing recommendations.
- Microservices, Kubernetes, message brokers, or a general-purpose workflow/BPM platform.
- Accounting-grade depreciation until the Finance policy and calculation examples are approved.
- Single sign-on until decision U6 is resolved.

### 2.3 Connectivity and offline policy

The provisional cloud-first policy is:

- Normal application use requires connectivity to the application server.
- Asset issue, transfer, return, procurement approval, receiving, exit-clearance decisions, disposal, and other transactions with competing state changes require a live connection to the authoritative API.
- Full offline transaction synchronization is not implemented in the current scope.
- Limited cached viewing or local drafts may be considered separately, but cached data must be visibly labelled as potentially stale and cannot imply that a server-side transaction was committed.
- Do not show a critical operation as complete until the server confirms its successful commit.

**Open decision U1:** Confirm whether any specific workflow must truly operate offline. Until confirmed, do not build a general offline-sync engine.

---

## 3. Target architecture

### 3.1 High-level architecture

```text
Authorized browsers (desktop and compatible mobile)
                    |
                 HTTPS
                    |
          TLS-terminating proxy / ingress
                    |
       Single modular web application container
       +----------------------------------------+
       | React + TypeScript browser application |
       | Fastify API                            |
       | Authentication / RBAC / domain services|
       | Parameterized SQL repositories         |
       +----------------------------------------+
             |                       |
       PostgreSQL              S3-compatible storage
       business records        documents / attachments
             |
   Managed backups / recovery
```

The logical frontend, backend, database, and file-storage boundaries must remain clear. For the initial product, a single deployable application/API is preferred over microservices.

### 3.2 Selected technology baseline

| Layer | Baseline decision | Implementation notes |
|---|---|---|
| Browser UI | React + TypeScript | Reuse current renderer components and shared types after reviewing their dependencies. |
| Backend | Fastify + TypeScript | Use route schemas and structured handlers. Keep business rules in services rather than route handlers. |
| Database | PostgreSQL | PostgreSQL is authoritative for shared records. Use versioned, checksummed SQL migrations. |
| SQL access | Parameterized plain SQL | Preserve explicit control over partial unique indexes, constraints, and triggers used by the design. Avoid introducing an ORM without a documented reason. |
| Validation | Shared TypeScript schemas where appropriate plus server validation | Never trust browser validation alone. |
| Authentication | Centralized server-side sessions | Store only a hash of session tokens. Use protected cookies and revocation. |
| File storage | S3-compatible storage behind a storage interface | Use local development implementation if needed; production must not depend on ephemeral container filesystem. |
| Packaging/deployment | Containerized application + managed PostgreSQL + S3-compatible file storage | Cloud provider and region remain undecided. No Kubernetes requirement. |
| Testing | Unit, PostgreSQL integration, HTTP/process, browser E2E, migration and security tests | Use a real temporary PostgreSQL instance for database invariants. |

### 3.3 Backend module boundaries

Organize the application as a modular monolith with clear areas such as:

- `auth` and `sessions`
- `organizations` and configuration
- `users`, `roles`, and `permissions`
- `departments`, `teams`, `employees`
- `locations`, `workstations`, and `asset pools`
- `asset catalog` (categories, models, suppliers)
- `assets` and lifecycle rules
- `documents` and storage abstraction
- `imports` and `exports`
- `allocations`, `movements`, and handover records
- `exit clearance`
- `maintenance`
- `procurement`, `receipts`, and approvals
- `physical audits`
- `finance` and reporting
- `audit events`

Keep domain/service logic independent of React. Keep persistence operations behind focused SQL repository or data-access modules. Avoid excessive abstraction around simple SQL, but ensure business rules can be tested without a browser.

### 3.4 API standards

- Use versioned API paths or a documented versioning policy.
- Define request and response schemas for every route.
- Validate path parameters, query parameters, bodies, and upload metadata server-side.
- Use parameterized SQL; never build SQL from untrusted strings.
- Return stable application error codes and non-sensitive messages.
- Never return stack traces, SQL statements, session hashes, password hashes, or storage credentials in production responses.
- Use response schemas/serialization to prevent restricted internal fields from leaking.
- Use pagination and bounded filters for potentially large lists.
- Apply authorization at the server for each route/action and each requested record.
- Treat browser-supplied organization IDs as untrusted. Resolve organization scope from authenticated server context or validate it against the session and authorization policy.
- Mutations return success only after transaction commit.
- For operations that may be retried, use idempotency or stable operation identifiers where duplicate execution would cause harm.
- Add correlation IDs to requests and safe diagnostic logs.

### 3.5 Repository and code organization

Exact folders should follow the current W1 repository conventions. A logical target structure is:

```text
src/
  web/ or renderer/           # React application
  server/
    app/                      # Fastify construction and plugins
    routes/                   # HTTP route definitions and schemas
    services/                 # Domain/application logic
    db/
      migrations/             # Versioned, checksummed SQL migrations
      repositories/           # Parameterized SQL data access
    auth/                     # Sessions, password verification, RBAC
    storage/                  # S3-compatible and local development adapters
    imports/                  # CSV/Excel parsing and validation
    exports/                  # Safe report/export generation
    audit/                    # Append-only audit event services
    config/                   # Validated configuration
  shared/                     # Safe shared types and validation contracts
  tests/
docs/
```

This is illustrative. Do not restructure the actual W1 repository solely to match this diagram if its current layout already provides the same separation.

---

## 4. Current W1 security foundation and required guarantees

W1 was reported to include the following controls; verify their current implementation and tests before changing them:

- Server-side session records, with only a hash of the session token stored.
- Session expiration after inactivity and after a 12-hour absolute lifetime.
- Immediate session revocation on logout, password changes/resets, or account deactivation.
- Account lock after five incorrect password attempts and per-IP login rate limiting.
- Cross-site request protection using origin checks and a required custom header.
- Strict Content Security Policy and error responses that do not expose internal details.
- Organization relationship constraints and an audit log protected from normal update/deletion.
- One-time `server:migrate` and `server:bootstrap` commands; setup must not be exposed as a public setup endpoint.

These are reported capabilities, not a claim that every deployment-related security requirement has been verified.

### 4.1 Authentication and sessions

- Use server-side sessions with cryptographically strong random tokens; persist only token hashes.
- Use `HttpOnly`, `Secure`, and appropriate `SameSite` cookie attributes for production HTTPS. Verify the exact cookie behavior behind the real TLS proxy before release.
- Apply idle and absolute expiry; W1 currently reports a 12-hour absolute limit. Record the inactivity timeout as a configuration/policy value and document it.
- Revoke sessions immediately on logout, password reset/change, deactivation, or other configured security events.
- Rate-limit login and recovery requests; prevent account enumeration through generic external responses where appropriate.
- Store password hashes using a maintained password-hashing algorithm and appropriate parameters; never store plaintext passwords.
- Keep password recovery decision U2 unresolved. Do not implement insecure email-based reset flows without an approved design.
- SSO is decision U6 and is not part of the initial release.

### 4.2 Authorization and roles

Use explicit permission keys, with role templates that can be configured by the Super Admin. The current starter roles are:

- Super Admin
- Asset Manager
- IT Support / Technician
- Facilities Manager
- Procurement Officer
- Department/Process Manager
- HR Officer
- Finance Officer
- Auditor / Compliance Officer
- Employee / Agent

A user may have multiple roles if permitted. The backend is authoritative for permissions. Sensitive fields such as acquisition cost and disposal proceeds must only be returned to authorized roles; the frontend must not be the only control.

Separate request creation and approval where practical. Enforce requester/approver separation where configured. Audit role and approval-policy changes.

### 4.3 Organization ownership and future tenancy

The initial deployment serves exactly one BPO organization, but the data model and services must keep ownership explicit.

Requirements:

- Tenant-owned root/business records carry `organization_id` where appropriate, or have an equally explicit and enforceable organization ownership path.
- Child records must be validated against the organization of their parent records.
- Every read and write must be scoped to the authenticated organization context.
- Related foreign keys should prevent cross-organization references where schema design allows it, using composite constraints or equivalent verified mechanisms.
- Explain precisely whether W1 uses query scoping, foreign keys, triggers, PostgreSQL Row-Level Security (RLS), or a combination. Do not claim RLS if it is not enabled and tested.
- Before adding a second tenant, complete a dedicated threat model, authorization review, cross-tenant test matrix, migration plan, and review of privileged database roles and policy bypass behavior.

A tenant/organization ID column alone does not prove tenant isolation. In the initial single-organization deployment, the controls should still be implemented and tested so they do not have to be retrofitted later.

### 4.4 Audit events

- Record actor, event type, entity type/ID, timestamp, reason where relevant, and correlation/transaction ID.
- Redact passwords, tokens, and unnecessary personal data.
- Log sensitive exports, policy changes, authorization changes, disposal/write-off, and other critical actions.
- The normal application must not offer audit editing or deletion.
- Document the limits of append-only protection: a privileged database operator may still be able to alter infrastructure-level data unless separate tamper-evident storage or external log export is added. Do not claim absolute tamper-proofing.

### 4.5 Request, browser and transport protection

- Enforce HTTPS in production and validate behavior behind the actual TLS-terminating proxy.
- Configure secure cookies and trusted proxy settings explicitly; do not trust arbitrary forwarded headers.
- Keep a strict CSP and avoid unsafe inline/eval policies except where demonstrably necessary and documented.
- Use Origin checks and the configured cross-site request protection. Test same-site and cross-site scenarios.
- Apply rate limits and request size limits.
- Prevent mass assignment by validating allowed fields and stripping/rejecting unexpected privileged fields.
- Use safe error messages and protected server logs.
- Set security headers and avoid exposing unnecessary server banners.

---

## 5. Business roles, organization, and employee management

### 5.1 User roles

| Role | Baseline responsibilities |
|---|---|
| Super Admin | User/role and permission configuration, organization settings, approval policy configuration, administration, and designated exception controls. |
| Asset Manager | Asset register, allocation, transfers, returns, labels, inventory, and physical audits. |
| IT Support / Technician | IT asset inspections, maintenance tickets, repair records and service history. |
| Facilities Manager | Facilities assets, locations, movement, and maintenance. |
| Procurement Officer | Purchase requests, suppliers, orders, receiving, and procurement documents. |
| Department/Process Manager | Requests and approvals within configured authority. |
| HR Officer | Employee lifecycle and exit-clearance coordination; access to only necessary asset/clearance information. |
| Finance Officer | Purchase costs, repair/disposal financial fields, and depreciation reports once enabled. |
| Auditor / Compliance Officer | Read-only records, audit events, verification results and reports within authorized scope. |
| Employee / Agent | View relevant assignments, acknowledge handovers, and report faults where policy allows. |

Permissions are policy-based. The above are starting templates, not an immutable access matrix.

### 5.2 Organization structure

The system must represent these separately:

- BPO organization profile.
- Departments.
- Teams/processes.
- Employees and managers.
- Physical sites/offices, buildings, floors, rooms, bays, storage areas and other location nodes.
- Workstations/seats.
- Shared asset pools.

An organizational team/process is not a physical location. Workstations/seats are distinct records and can be assignment targets. Deactivation should be blocked or require a documented reassignment/exception when active dependent records exist.

### 5.3 Employee records and import

Employee records support employee ID/code from the HR source, name, optional email/phone as needed, department, team/process, manager, joining date, exit date/reason, status, and timestamps. Collect only necessary personal data.

Current M2 decisions reported:

- Employee IDs are supplied by the HR system; the app does not generate them.
- Duplicate email is a warning by default and can be set to reject in Settings.
- Date format is chosen per import file; the app does not guess ambiguous day-first/month-first dates.
- Current employee CSV import creates records only; it does not update existing employees.
- Department, team and location references must already exist before import.
- CSV currently requires UTF-8; handling of legacy encodings remains a documented improvement.
- Excel `.xlsx` import was not part of M2; `read-excel-file` was recorded as a candidate for a later decision. Verify current dependency metadata/security before adding it.

Import requirements:

- Preview must never write to the database.
- Validate the whole file before commit and show row-level errors/warnings/duplicates.
- Revalidate inside the commit transaction.
- By default, any rejected/duplicate row blocks the whole import; if explicit skip-invalid mode is offered, the user must knowingly select it and see the resulting counts.
- Existing employee records must not be silently overwritten.
- Commit all accepted rows atomically or none when in all-or-nothing mode.
- Log aggregate counts and a file fingerprint, not unnecessary personal data.
- Protect exports from spreadsheet formula injection.

---

## 6. Asset catalogue and inventory

### 6.1 Supported categories

Examples include:

| Category | Examples | Tracking policy |
|---|---|---|
| Computing | Desktops, laptops, thin clients | Individual asset |
| Peripherals | Headsets, monitors, keyboards, mice, docking stations | Individual or approved bulk tracking based on policy/value |
| Network/infrastructure | Switches, routers, access points, UPS units, servers | Individual asset |
| Facilities | Desks, chairs, cabinets, fixtures | Individual or approved grouped tracking |
| Office equipment | Printers, scanners, projectors, meeting room equipment | Individual asset |

The category model must determine whether an item is individually tracked or quantity-tracked. Bulk-tracked items are not appropriate where individual custody, serial traceability, or high-value history is required.

### 6.2 Asset code and identity

- Internal primary IDs use UUIDs or the consistent identifier format already used by the cloud implementation.
- Human-readable asset code is separate from the internal primary ID.
- The current M3 desktop implementation uses configurable codes such as `AST-000001`; preserve this behavior where suitable. The Super Admin can configure prefix, separator, digit count, and next number, subject to permission and reason capture.
- Asset codes must be unique, immutable after creation, and never reused, including after retirement/disposal or prefix changes.
- Code generation must be concurrency-safe at the server/database layer. Multiple concurrent asset creations must not receive the same code.
- Do not embed category, employee, department, or location in the code.
- QR payloads contain only an opaque internal asset identifier; do not include employee personal information, purchase cost, secrets, or unrestricted file paths.

### 6.3 Asset record

At minimum, an individually tracked asset includes:

- ID, organization ownership, asset code.
- Category, model, manufacturer and model snapshots.
- Serial number and configurable category/manufacturer uniqueness policy.
- Purchase/receipt linkage, acquisition date, acquisition cost in integer minor currency units, currency, supplier and invoice reference.
- Warranty start/end.
- Lifecycle status, operational status and condition.
- Physical location.
- Notes and document relationships.
- Created/updated timestamps and historical events.

Editing an asset model later must not silently rewrite historical manufacturer/model details stored as a snapshot on existing assets.

### 6.4 Separate lifecycle, operational, and assignment state

Do not collapse all asset states into one status.

- **Lifecycle:** `active`, `retired`, `lost`, `disposed` (with permitted transitions enforced).
- **Operational:** `ready`, `under_maintenance`, `non_operational`, `awaiting_inspection`.
- **Assignment:** derived from active assignment records, not an independently editable `available` flag.
- **Condition:** `new`, `good`, `fair`, `damaged`, `unknown` or a controlled equivalent.

An asset is eligible for issue only when active, operationally ready, unassigned, and not on hold. A found/reinstated asset returns to an inspection-required state rather than becoming immediately available.

Dispose/loss/retirement transitions must validate assignment state. If an asset is assigned, the system must resolve or explicitly authorize the assignment exception before finalizing the lifecycle change.

### 6.5 Asset search and export

Support search by asset code, serial, make/model, category, supplier, location, employee/target where authorized, and status. Provide bounded pagination, filters, sorting and detail views.

Exports must:
- Use only records the current user is authorized to view.
- Include acquisition cost/disposal proceeds only for users with the appropriate finance permission.
- Escape or neutralize untrusted spreadsheet cell values to prevent formula injection.
- Be logged when security-relevant, with aggregate metadata and no needless personal data.

---

## 7. Documents, uploads and object storage

### 7.1 Storage model

Use a storage abstraction, with S3-compatible object storage as the production target and a controlled local implementation for development/testing. Do not depend on a container's ephemeral writable filesystem for production documents.

Store metadata in PostgreSQL:
- document ID and organization ownership;
- generated storage key, not a user-provided path;
- original display filename (display only, safely encoded);
- detected media type, size, checksum;
- uploader and created timestamp;
- status such as pending scan/available/rejected/quarantined where scanning is configured;
- business links by entity and relationship purpose.

Because document links can refer to several entity types, the service layer must validate each owner and organization relationship. Test for orphaned or cross-organization links.

### 7.2 Upload/download requirements

- Require authentication and authorization for every upload, download and delete/unlink operation.
- Enforce file-size limits at proxy, server and application layers.
- Use generated storage keys and safe file naming; never concatenate user filenames into filesystem/object paths.
- Validate extension, declared MIME type, actual file signature/content where applicable, and allowed file type policy.
- Store and verify checksums; reject altered or corrupt files.
- Use safe `Content-Disposition` and `Content-Type` headers; do not render untrusted active content inline without a deliberate policy.
- Avoid public object ACLs by default; use authorized server-mediated downloads or short-lived signed URLs under a documented policy.
- Ensure attachment links do not bypass parent entity permissions.
- Audit security-relevant downloads, replacements and unlink operations where appropriate.
- Unlinking a document from a record is not necessarily the same as permanently deleting the object; retention and legal hold rules must be defined.

**Open decision U3:** Malware scanning of uploads. Before production upload is enabled, decide whether scanning is mandatory, what happens to pending/quarantined files, and how scanning failures are handled. Until resolved, clearly document the provisional restriction and do not claim the upload pipeline is malware-safe.

---

## 8. QR/barcode identification

### 8.1 Label content

A label may show the organization display name, human-readable asset code, QR code and barcode. QR content must be an opaque identifier only. Current desktop behavior uses a 64 × 30 mm label; the cloud version may retain that default but should avoid hard-coding the physical size throughout UI logic.

### 8.2 Supported scanning

- USB barcode scanner using its keyboard-wedge behavior in a focused scan field.
- Manual exact asset-code entry and serial-number lookup.
- Browser camera scanning for QR codes where supported and securely deployed.

A scan must not issue, return, transfer, dispose, or otherwise mutate an asset by itself. Show the resolved record and require the authorized user to confirm any state-changing transaction.

**Open decision U5:** Phone-camera scanning. The browser version removes the need for the old desktop-to-phone local endpoint, but camera permissions, secure-context requirements, supported devices, and manual/USB fallback still require testing. Keep QR-camera scanning behind a controlled capability check; USB and manual search remain supported.

---

## 9. Allocation, transfer, returns and acknowledgment (W4)

### 9.1 Assignment targets

Each assignment targets exactly one of:
- Employee.
- Workstation/seat.
- Department/team.
- Shared asset pool.

Physical location is separate from the assignment target. An asset assigned to an employee may have a physical location at a specific office or seat.

### 9.2 Assignment record and history

Each assignment preserves:
- ID, organization, asset ID and exactly one target reference;
- start/end timestamps and expected return where relevant;
- issuer, recipient/target, physical location at issue;
- condition at issue and return;
- acknowledgment method/evidence;
- transfer/return reason and notes;
- current status and creation timestamp.

Never overwrite a closed assignment to represent a later assignment. Close the prior assignment and create a new record/movement. Corrections require a reason and actor rather than deletion.

### 9.3 Concurrency and invariants

- At most one active assignment may exist for an individually tracked asset.
- Enforce this with PostgreSQL constraints/indexes where possible and a transactionally safe service flow.
- Concurrent requests that attempt to issue the same asset must produce one successful active assignment at most; the other request receives a clear conflict response.
- The check must be tested with genuinely concurrent database requests, not only sequential unit tests.
- The operation must atomically write the assignment, asset movement/history and audit event where applicable.
- Failed transactions must not leave partial assignment or movement records.

### 9.4 Handover acknowledgment

Default to explicit in-app acknowledgment. Preserve recipient, asset, condition, date/time, actor and transaction context. Support a printable receipt for physical signatures and attach signed evidence where required. Do not require a drawn electronic signature for every transaction unless the business approves that policy.

### 9.5 Returns and inspections

Return records must capture receiver, return time, condition, accessories where required, and resulting state. Faulty or inspection-required assets must not become available automatically. Assignment closure and resulting state updates are transactional.

---

## 10. Employee exit clearance

1. Open clearance for an employee and expected exit date.
2. List all assets under active assignments for which the employee is custodian, plus other explicitly configured custody relationships.
3. Record each expected item as returned, outstanding, disputed, damaged, missing, or exception-approved.
4. For returned items, close the active assignment and record inspection/condition.
5. Record missing/damaged/disputed exceptions with owner, reason and evidence.
6. Require an authorized decision to resolve exceptions.
7. Close clearance only when every required item is resolved or an allowed exception is approved.

Deactivating an employee must never automatically return or reassign assets. HR should see overall clearance status without automatically receiving restricted IT, security, or financial detail.

Any connection to payroll deductions/final settlement is out of scope and must be reviewed separately before adding.

---

## 11. Maintenance and repair

### 11.1 Capabilities

- Fault report from an authorized user or technician.
- Ticket number, asset link, category, description, priority, status and target resolution time.
- Reporter, assigned technician, vendor and service references.
- Diagnosis, work performed, parts, labor/service costs, downtime and supporting documents.
- Status/event history, closure result and authorized return-to-service decision.
- Reports for open/overdue tickets, repair frequency, downtime, costs and vendor performance.

### 11.2 Rules

- A maintenance ticket remains a distinct record; do not overwrite earlier service events.
- Maintenance status and asset operational status must be updated consistently through a transaction or explicit domain workflow.
- Closing a ticket does not automatically make an asset available if assignment, lifecycle, inspection or other conditions still block it.
- Cost fields and financial reports are permission-controlled.

---

## 12. Procurement, receiving and approvals

### 12.1 Procurement workflow

1. Requester creates a purchase request with justification, line items, quantity, estimate and required date.
2. The server resolves the applicable approval policy and snapshots its version at submission.
3. Authorized approvers act in the configured order; decisions and reasons are retained.
4. An approved request may be associated with a purchase order or external purchase reference.
5. Receiver records full/partial receipt, rejected items, discrepancies and documents.
6. Individually tracked goods become asset records; quantity-managed goods become bulk stock records only when that capability is approved.
7. Receipt totals and purchase-order status are reconciled.

Approval is not receipt. Assets cannot be issued until required registration and receiving checks pass.

### 12.2 Approval configuration

The Super Admin configures:
- Transaction types requiring approval.
- Amount thresholds where applicable.
- Ordered approval steps.
- Required roles or named approvers.
- Requester/approver separation rules.
- Exception, disposal, write-off and override authority.

Validate approver authority at decision time. Do not hardcode one approver or universal rupee threshold. In-flight approvals should use the policy version selected at submission; editing current policy should not silently rewrite pending approval chains.

### 12.3 Procurement data and invariants

Track purchase requests/items, order references/items, suppliers, goods receipts/items, ordered/received/rejected/outstanding quantities, inspection results and document links. Support partial receipts. Avoid duplicate asset creation when retrying a receipt operation.

---

## 13. Physical audit and inventory verification

- Create an audit by site, floor, category, custodian, or selected inventory set.
- Generate the expected asset list from current authoritative records.
- Record scans/observations, operator, timestamp, observed location and condition.
- Flag missing, unexpected, mismatched-location, duplicate-label or condition discrepancies.
- Do not silently alter master data because a scan differs; create a discrepancy requiring review.
- Assign investigation and resolution ownership.
- Close only after discrepancies are resolved or formally accepted by an authorized role, retaining a summary and remaining-exception list when policy allows.

---

## 14. Finance and depreciation

### 14.1 Initial financial scope

- Acquisition cost and currency.
- Purchase/acquisition date.
- Supplier and invoice references.
- Warranty dates.
- Repair/maintenance expenses.
- Disposal date and proceeds where relevant.
- Authorized purchase-cost and warranty reports.

Store money in integer minor currency units (for example, paise for INR) or use a PostgreSQL exact-decimal strategy with an explicitly defined rounding policy. Do not use JavaScript floating-point values as the accounting source of truth.

### 14.2 Deferred depreciation

Finance has not confirmed its depreciation requirements. Keep method, useful life, residual value, start date, policy version and related fields nullable/configurable as appropriate, but do not produce authoritative depreciation or net-book-value reports until Finance approves:

- Method(s) by asset class.
- Useful life.
- Residual/salvage value.
- Start-date convention.
- Proration and rounding rules.
- Treatment of tax, shipping, installation and capitalizable costs.
- Currency handling.
- Difference, if any, between management reporting and official accounting schedules.

Before enabling, create tests based on Finance-approved numerical examples. This system does not replace the general ledger or official accounting system.

---

## 15. Reporting and dashboard

### 15.1 Dashboard

Metrics must be derived from live PostgreSQL records, not hardcoded demo values. Include:
- Total active assets and distinct views for assigned, available, under maintenance, awaiting inspection, lost, retired and disposed.
- Pending purchase requests/approvals.
- Open and overdue maintenance tickets.
- Pending returns and exit-clearance exceptions.
- Warranties expiring within a configurable window.
- Physical audits and unresolved discrepancies.

An asset awaiting inspection is not available. Retired/disposed assets must not be counted as active inventory.

### 15.2 Reports

Provide authorized, filterable reports for:
- Asset register by category, site, location, department, custodian, supplier and status.
- Assignment, transfer and return history.
- Employee exit clearance and exceptions.
- Maintenance backlog, downtime, repair costs and vendor performance.
- Purchase requests, approvals, receiving and procurement spend.
- Warranty expiry and upcoming maintenance.
- Acquisition cost and financial summaries; depreciation only after policy approval.
- Physical audit results and unresolved discrepancies.
- Missing, damaged, retired and disposed assets.

Use server-side pagination and bounded queries. Verify field-level authorization in report endpoints and exports, not just in the screen.

### 15.3 Exports

- CSV export must protect against spreadsheet formula injection.
- Exports only include records and fields the user may access.
- Financial fields are returned only when the user holds the appropriate permission.
- Log sensitive/bulk exports with actor, filters or scope, timestamp and counts; avoid logging unnecessary personal data.
- Avoid unbounded export requests that can exhaust application memory.

---

## 16. Database and data-model design

This section describes the logical data model. Implement exact types, indexes, constraints and SQL migrations in the repository. Inspect the existing W1 schema first; reuse and evolve it through forward migrations rather than recreating it from scratch.

### 16.1 Organization and identity

Logical entities include:
- `organizations` or the existing W1 organization profile table.
- `users`, `roles`, `permissions`, `user_roles`, `role_permissions`.
- Session records storing token hashes, expiry/revocation metadata and user relationship.
- `departments`, `teams`, `employees`.
- `locations`, `workstations`, `asset_pools`.

Employee records and login users are distinct concepts; link them where appropriate rather than assuming every employee must have login access.

### 16.2 Catalogue and assets

Logical entities include:
- `asset_categories`, `asset_models`, `suppliers`.
- `assets` with asset code, serial-number policy, category/model snapshots, purchase/warranty fields, lifecycle/operational state, physical location and organization ownership.
- `bulk_stock_items` and `stock_movements` only for approved quantity-tracked categories.
- Financial profile fields where required, with depreciation policy fields remaining optional until approved.

### 16.3 Documents

Logical entities include:
- `documents` metadata, storage key, checksum, size, detected media type, uploader, status and organization.
- `document_links` or equivalent typed relationship tables.

Because polymorphic entity references cannot normally rely on a single simple FK to several tables, explicitly validate linked entity existence and organization scope. Where practical, use typed link tables or another design that makes integrity easier to enforce.

### 16.4 Assignment and history

Logical entities include:
- `asset_assignments` with one target exactly, location, issue/return data, condition, acknowledgment, actor and status.
- `asset_movements` or equivalent append-only events.
- Assignment history must be retained; correction is a new event/reversal, not deletion.
- The schema/service must enforce at most one active assignment for an individually tracked asset.

### 16.5 Procurement and approval

Logical entities include purchase requests/items, purchase orders/items or order references, goods receipts/items, approval policies/steps, approval instances and decisions. Approval instances should retain the policy version or snapshot used at submission.

### 16.6 Maintenance and audits

Logical entities include maintenance tickets/events and physical audit sessions/items/discrepancies, with user, asset, location, document, status and timestamp relationships.

### 16.7 Exit clearance

Logical entities include exit clearances and clearance items with employee, asset/assignment reference, resolution status, evidence, reviewer and timestamps.

### 16.8 Audit and migrations

- Audit events include ID, organization scope, actor, event/action, entity, reason where relevant, timestamp, correlation/transaction ID, and redacted before/after summary.
- Schema migrations are versioned and checksummed. The migration mechanism prevents concurrent duplicate execution and refuses silently altered applied migrations.
- Audit event rows are protected from application-level updates/deletes; document the limits of infrastructure-level tampering as stated in §4.4.

### 16.9 Database constraints and concurrency

At minimum:
- Unique normalized usernames and appropriate unique role/permission relationships.
- Unique asset codes and appropriate ticket/order/request numbers.
- Category/manufacturer-specific serial uniqueness according to the category's configured policy.
- Foreign-key integrity and checked ownership relationships.
- Valid enum/check constraints and sensible nonnegative amounts/quantities.
- Exactly one assignment target per assignment.
- One active assignment per individually tracked asset, enforced using a PostgreSQL partial unique index or another documented, tested transactional invariant.
- Parameterized SQL everywhere.
- Tests for simultaneous conflicting transactions, rollback and invalid cross-organization references.

Do not rely only on an application-level “check then insert” when the database can enforce the invariant; concurrent requests can race.

---

## 17. Data migration from SQLite prototype

The prototype remains useful as a reference and potential source of real operational data. A controlled migration path is required before production use.

### 17.1 Migration process

1. Identify and verify the source SQLite database and schema version.
2. Create a read-only source copy or use a safe consistent extraction method; never alter the source database.
3. Detect and refuse demo/test-seeded data unless a separately approved test migration is intended.
4. Run a dry-run transformation into a temporary target/staging database or isolated migration context.
5. Validate record counts, unique identifiers, foreign keys, organization relationships, asset codes, serial uniqueness, status transitions, assignment invariants, file references and checksums.
6. Produce a human-readable validation report of creates, mappings, skips, warnings, errors and count differences.
7. Require explicit authorization to apply the migration.
8. Apply in controlled transactions/batches with a defined rollback/recovery strategy.
9. Verify target records and relationships after import.
10. Keep migration logs free of unnecessary personal data and protect any temporary exports.

### 17.2 Preservation requirements

- Preserve stable UUIDs and human-readable asset codes.
- Preserve employees, departments, teams, locations, assets, assignments, audit events and document links where supported.
- Preserve chronological history; do not manufacture historical events to cover missing data.
- Do not silently discard malformed or orphaned records; report them for review.
- Keep the source database unmodified.
- Do not import demo assets or fixtures into a production database.

The migration implementation should be tested against copies of realistic prototype data, including edge cases and migration failures.

---

## 18. Backup, recovery and operational reliability

The desktop backup screens do not carry over to the cloud architecture. Backup/recovery is primarily an operational and managed-service concern, with documented procedures and controlled administrative tools where needed.

### 18.1 Database backup

- Use managed PostgreSQL automated backup and point-in-time recovery capabilities where available and appropriately configured.
- Document retention, encryption, access control, RPO and RTO. Proposed values must be confirmed with the BPO owner and hosting choice.
- Maintain a recovery procedure for accidental deletion, failed migrations, application compromise and provider/region failure as required by the chosen deployment.
- Do not claim recovery readiness until a restore into an isolated environment has been exercised and validated.

### 18.2 Object storage backup/recovery

- Define object versioning, deletion protection/retention, replication where required, encryption, and restore procedures according to the selected storage provider.
- Ensure the DB restore and object-store recovery can be coordinated so document metadata and objects remain consistent.
- Retain checksums/manifests and verify object availability after restore.

### 18.3 Restore and migration safety

- Database migrations must be reviewed and tested on a representative database before production.
- Use one-time administrative migration commands, not a public unauthenticated setup route.
- Have a pre-deployment backup and rollback/recovery plan for schema changes.
- Record operational actions and outcomes without exposing credentials.

### 18.4 Recovery targets

Cloud provider/region and business RPO/RTO remain undecided (U4). Propose measurable targets after selecting the hosting provider and understanding operating requirements. Restore drills must be part of release readiness.

---

## 19. Hosting, deployment and environments

### 19.1 Target deployment

- One application container running the web app/API.
- Managed PostgreSQL.
- S3-compatible object storage.
- TLS termination at a configured proxy/load balancer/managed ingress.
- No Kubernetes, service mesh, distributed message broker or microservices in the initial release.

### 19.2 Environments

Maintain separate development, test/CI, staging and production configuration/data. Never seed production with demo data. Do not share production credentials with development environments.

### 19.3 Configuration and secrets

- Validate required configuration at startup.
- Keep secrets out of source control and container images.
- Use deployment secret management appropriate to the provider.
- Keep SQL migrations and bootstrap commands explicit and auditable.
- Bootstrap the initial organization/Super Admin through one-time controlled commands such as the reported `server:bootstrap`; do not expose public first-run setup routes.
- Pin and review dependencies; run production dependency audits as part of CI/release checks.

### 19.4 Health, logging and monitoring

- Provide safe liveness/readiness checks that do not disclose secrets or detailed infrastructure state publicly.
- Log structured request IDs, severity, subsystem and safe diagnostics.
- Do not log session tokens, password data, document contents or unnecessary personal details.
- Monitor application errors, database availability, storage failures, authentication abuse, migration status, backup status and resource saturation.
- Configure alerts appropriate to the selected hosting platform.

### 19.5 Hosting decisions

**Open decision U4:** Cloud provider and region. Keep the application portable while not pretending that provider-specific networking, backups and secrets are identical. Choose a provider before production deployment and validate TLS, cookies, database access, file storage, backups and recovery in that real environment.

---

## 20. Performance and reliability targets

These are targets to measure, not promises before testing:

- Common list/search API calls: target p95 under 2 seconds under an agreed representative test load.
- Common read/detail views: target p95 under 2 seconds excluding large document transfers.
- Common transactions: target p95 under 2 seconds at normal test load, excluding human approval time and external storage delay.
- All large lists are paginated and queries bounded.
- Import/report operations over larger files/datasets must not block the browser UI and should provide progress or a clear completion result.
- Database transactions must keep related records consistent.
- Failures must return safe actionable errors and structured server diagnostics.
- Load tests should use an agreed employee/asset volume and multi-year assignment, maintenance, and audit history. Employee count alone does not determine workload.

---

## 21. Testing and acceptance criteria

### 21.1 Required test layers

- Unit tests for domain rules, validation, state transitions, permission evaluation, approval routing and money handling.
- PostgreSQL integration tests against a real temporary/test database, not only SQLite mocks.
- Migration tests including upgrade of a prototype data copy and refusal of altered checksums where supported.
- HTTP/process tests for authentication, cookie flags, session revocation, cross-site request defense, route validation and safe errors.
- Browser end-to-end tests against the real API for sign-in, access control, asset registration, search, import, document upload/download, labels and exports.
- Concurrency tests for issue/transfer/return and code generation where applicable.
- Data-migration dry-run/apply/verify tests, including refusal of demo data and preservation of source data.
- Upload validation, unauthorized attachment access and storage-failure tests.
- Security tests for organization ownership and cross-organization access attempts.
- Deployment smoke tests using a production-like container, PostgreSQL and object store.
- Restore drills for database and documents.

### 21.2 Release acceptance criteria

- [ ] Authorized users can sign in and server-side sessions obey expiry and revocation policies.
- [ ] Every protected operation enforces server-side permissions.
- [ ] Organization ownership is validated on reads, writes, joins, imports, exports and document links.
- [ ] PostgreSQL migrations run safely, are versioned/checksummed and cannot execute concurrently in conflicting ways.
- [ ] Asset IDs/codes are unique, stable and concurrency-safe.
- [ ] Employee/organization/asset catalogues persist through PostgreSQL and work through the browser UI.
- [ ] CSV import has preview, validation, duplicate checks, row errors, and atomic commit/explicit skip mode.
- [ ] Document upload/download obeys permission, size, content, storage-key and safe-response rules.
- [ ] Sensitive fields are not returned to unauthorized roles, including in exports.
- [ ] Asset issue/transfer/return prevents duplicate active assignments under concurrent requests.
- [ ] Return condition and inspection history is retained; faulty assets are not automatically available.
- [ ] Exit clearance identifies assigned assets and cannot silently close with unresolved exceptions.
- [ ] Procurement, approvals and receipt workflows preserve decision history and policy versions.
- [ ] Maintenance and physical audit create traceable histories and discrepancies.
- [ ] Acquisition cost and warranty reports reconcile to persisted data; depreciation remains disabled until Finance policy is approved.
- [ ] Backup and database/object-store recovery are tested in an isolated environment.
- [ ] TLS, session cookies and trusted-proxy behavior are verified behind the actual production ingress.
- [ ] Security/dependency checks and browser E2E tests pass or residual risks are formally documented and accepted.
- [ ] No production readiness claim is made before deployment, operational and recovery checks have actually passed.

---

## 22. Implementation roadmap

The W-series phases describe the cloud migration and replacement application path. The old M-series desktop milestones remain historical reference only.

### W0 — Architecture v2 and migration plan (reported complete)

- Record the cloud architecture choice and offline conflict.
- Compare Fastify/plain SQL with alternatives.
- Create a migration matrix for M1–M3.
- Define provider-neutral deployment and SQLite-to-PostgreSQL migration principles.

### W1 — Server foundation (reported committed as `bd360bb`)

Reported capabilities: Fastify server foundation; checksummed/versioned PostgreSQL migrations with concurrency protection; centralized sessions; authentication, lockout/rate limiting, cross-site request defense, CSP and safe errors; bootstrap/migrate commands; initial organization/security boundaries; protected audit events.

Reported tests included typecheck, unit/integration tests using PostgreSQL 18.1, live-process HTTP checks, session/CSRF tests, permission checks and a production dependency audit. Re-verify current repository status and actual test scripts before relying on these results.

Not reported as verified at W1 completion: HTTPS cookie behavior behind real TLS proxy, cloud deployment, file storage and browser UI integration.

### W2 — Server-backed organization, employee, catalogue and asset modules (next/current planned phase)

- Port departments, teams/processes, locations, workstations/seats, pools and employee records to PostgreSQL/API.
- Port CSV preview/validation/atomic import.
- Port categories, models, suppliers, assets, code generation, lifecycle data, documents, labels, scanning, search and exports.
- Add upload/download endpoints and storage abstraction.
- Reuse validated domain logic; replace SQLite persistence safely.
- Test on real PostgreSQL and against the actual API.

**Exit criteria:** These modules have server persistence and tests, authorization is enforced, document storage access is protected, migration/invariants pass, and the schema/API can support W3 browser integration.

### W3 — Browser application integration

- Connect React screens to the cloud API.
- Replace desktop-only IPC/local database assumptions with typed HTTP API clients.
- Implement central sign-in/session lifecycle and server error handling.
- Complete end-to-end flows through the real browser and API.
- Validate role-specific UI and server response-field authorization.

**Exit criteria:** Browser screens use real API data; no core flow relies on prototype/local SQLite; essential workflows pass browser E2E tests.

### W4 — Allocation, transfers, returns and exit clearance

- Implement assignment targets, active assignment constraints, movement/assignment history, handover acknowledgment/receipts, return inspection, employee clearance and exceptions.
- Resolve the prototype issue where assets could be retired/lost/disposed while assigned.
- Test competing requests attempting to issue the same asset simultaneously.

**Exit criteria:** No duplicate active assignment under concurrency; all custody workflows are auditable and validated through browser/API tests.

### W5 — Maintenance and physical audit

- Maintenance tickets/events, condition transitions, costs/downtime, vendors and documents.
- Physical audits, expected asset sets, scanning, discrepancy assignment and closure.

**Exit criteria:** Complete maintenance history and audited physical verification with no silent master-data changes.

### W6 — Procurement, receiving and approval workflows

- Requests/items, configurable approval policies/steps, policy snapshots, orders/records, partial goods receipts, rejects and asset registration from receipt.

**Exit criteria:** Approvals use configured authority, prohibited self-approval is prevented, receipt reconciliation is correct, and retries do not create duplicate records.

### W7 — Finance, reporting and operational hardening

- Acquisition cost, warranty, repair-cost and disposal reports.
- Financial permission controls and safe exports.
- Depreciation only after Finance rules are approved.
- Performance tests, upload security, audit review, monitoring, and operational documentation.

**Exit criteria:** Business reports reconcile, security controls pass, and key outstanding policy decisions are resolved or formally deferred.

### W8 — Deployment, recovery drills and pilot

- Select provider/region and deployment configuration.
- Deploy to staging using the intended container, PostgreSQL and storage configuration.
- Verify TLS proxy, cookies, secrets, health checks, backups, document recovery and database restoration.
- Migrate a validated pilot dataset using dry-run/apply/verify.
- Train users, pilot the core workflows, address defects, and obtain BPO owner sign-off.

**Exit criteria:** Staging/production-like verification, recovery exercises, data reconciliation, user access review and operational ownership are complete. Production launch remains subject to formal approval.

---

## 23. Open decisions and provisional defaults

| ID | Decision | Provisional default / treatment | Required before |
|---|---|---|---|
| U1 | Offline workflows | Cloud-first; critical state-changing workflows require live API; no full offline sync | Before promising offline functionality |
| U2 | Self-service password recovery | Not finalized; use an explicit, secure admin/reset policy until the recovery flow is approved | Before production recovery flows |
| U3 | Malware scanning of uploads | Open; define quarantine/scan/failure behavior and permitted file types before production uploads | Before production document uploads |
| U4 | Cloud provider and region | Provider-neutral container + managed PostgreSQL + S3-compatible storage; selection deferred | Before deployment-specific configuration and launch |
| U5 | Phone-camera scanning | Support USB and manual lookup; browser-camera support subject to secure-context/device tests | Before advertising phone scanning as supported |
| U6 | SSO | Not in initial release; centralized username/password/session model | Before enterprise SSO integration |
| F1 | Depreciation policy | Acquisition cost/warranty first; depreciation disabled pending Finance policy | Before enabling depreciation reports |
| B1 | Asset code format | Preserve configurable format such as `AST-000001`; generated server-side, immutable and non-reusable | Before asset code implementation is finalized |
| B2 | Bulk tracking categories | Individually track high-value/serialized assets; bulk tracking only for explicitly approved low-cost categories | Before stock/procurement bulk flows |
| B3 | Handover evidence | In-app acknowledgment by default; printable receipt/attached signed evidence where required | Before W4 acceptance |
| B4 | Approval templates | Super Admin configures approvers and thresholds; obtain BPO business sign-off | Before live procurement approvals |
| B5 | Initial data migration | Dry run, validation report, apply/verify; reject demo data and preserve source | Before any production migration |
| B6 | Backup objectives | Define RPO/RTO and retention with BPO owner/provider; restore test required | Before production |
| B7 | Email delivery | Determine whether notifications/reset flows require email provider and configure only when approved | Before features relying on email |

---

## 24. Requirements traceability

| Requirement group | Primary phase | Acceptance evidence |
|---|---|---|
| Central authentication and sessions | W1 / W3 | Session expiry/revocation HTTP tests; browser sign-in E2E |
| RBAC and sensitive fields | W1 / W2 / W3 | API allow/deny tests and field-level response/export tests |
| Organization structure/employees/import | W2 / W3 | PostgreSQL integration and browser CSV import tests |
| Asset catalogue/register/code generation | W2 / W3 | Unique constraints, concurrency, search, browser registration and export tests |
| Documents/storage | W2 / W3 | Upload/download permission, content, checksum and storage failure tests |
| Labels and scanning | W2 / W3 | Label generation/printing and USB/manual scanning tests; camera tests if enabled |
| Allocation/transfers/returns | W4 | Concurrent conflicting assignment, transaction rollback and history tests |
| Employee exit clearance | W4 | Outstanding assets, exceptions and closure authorization E2E tests |
| Maintenance | W5 | Ticket transition, cost/history and state consistency tests |
| Physical audits | W5 | Discrepancy and authorized resolution tests |
| Procurement/receiving/approval | W6 | Policy snapshot, role separation, partial receipt, rollback and retry tests |
| Finance/reporting | W7 | Permission, reconciliation, export safety and Finance-approved examples |
| Hosting/backups/recovery | W8 | TLS/cookie checks, deployment smoke tests and database/object-store restore drills |
| Multi-tenant SaaS | Future separate phase | Dedicated threat model, isolation tests, provisioning and migration plan; not enabled by initial release |

---

## 25. Definition of planning and release readiness

Planning is sufficient to continue W2 when:
- The cloud architecture and W0 decisions are recorded.
- W1 foundation is committed and its tests are reproducible.
- W2 has a scoped implementation plan and module migration matrix.
- The offline conflict is documented with a provisional default.
- The database, API, document-storage and authorization patterns are sufficiently defined.

Production readiness requires more than completing code or passing unit tests. It requires the actual deployment to be tested, TLS/cookie behavior verified, database and object storage recovery rehearsed, upload security policy resolved, browser end-to-end workflows passing, tenant-boundary controls validated, and remaining risks documented and accepted by the BPO owner.

**Recommendation:** Continue with W2 under this v2.0 specification, then connect and verify the browser UI in W3 before implementing W4. Do not deploy to production until W8 acceptance criteria are met.

---

## 26. Historical references and related documents

- `BPO_ASSET_MANAGEMENT_TAS_v1.0.md` — historical standalone Electron/SQLite specification; superseded for new development.
- `docs/ARCHITECTURE_V2_CLOUD.md` — detailed cloud architecture rationale and migration decisions.
- `DECISIONS.md` — accepted decisions and unresolved questions.
- `IMPLEMENTATION_PLAN.md` — current phase status and sequencing.
- `PROJECT_STATUS.md` — current repository state and next actions.
- `JOURNAL.md` — concise implementation history and test outcomes.
- `KNOWN_ISSUES.md` — confirmed limitations and outstanding risks.
- `CLAUDE.md` — project development instructions and token-efficient continuation rules.

### Primary implementation references

Consult the current official documentation for the pinned versions actually used in the repository. Do not copy version-specific examples without verifying compatibility.

- Fastify documentation: https://fastify.dev/docs/latest/
- PostgreSQL documentation: https://www.postgresql.org/docs/
- Electron security guidance (historical prototype only): https://www.electronjs.org/docs/latest/tutorial/security
- React TypeScript guidance: https://react.dev/learn/typescript
- OWASP guidance for web applications and file uploads should be consulted when implementing the relevant controls.

---

**Version 2.0 change summary:** Replaces the standalone Electron/SQLite deployment baseline with a cloud-based React/TypeScript + Fastify + PostgreSQL architecture; adds centralized authentication/session, API authorization, organization ownership, object storage, cloud deployment and recovery requirements; explicitly documents the offline-policy conflict; preserves the original BPO asset-management scope; maps implementation to W0–W8 and traceable acceptance criteria.
