# Controlled BPO pilot plan (W8, TAS §19/§21)

This is a plan, not an executed pilot. No real BPO data has been touched by this project. Moving
from stage to stage requires the business owner's explicit sign-off at each gate below.

## Stage 0 — Prerequisites (must be true before Stage 1 starts)
- A cloud provider is selected and provisioned (DECISIONS.md D47 is a recommendation, not a
  selection) with a production-grade managed PostgreSQL and S3-compatible storage.
- U2 (password recovery) and U3 (malware scanning, or an accepted restricted-upload policy) are
  resolved, or the business owner explicitly accepts the documented interim restrictions.
- A backup/recovery rehearsal has passed in the target topology (not just the local drill in
  `tests/server/backup-restore.test.ts` — that proves the mechanism, not the production topology).

## Stage 1 — Isolated staging, synthetic data
1. Deploy to a staging environment, isolated from any real BPO network/data.
2. Load **synthetic or sanitized** data only — no real employee names, real asset serials, or real
   financial figures at this stage.
3. Configure Super Admin, roles, and the approval policy the business actually intends to use
   (W6) — not the test fixtures.
4. Walk every representative workflow end to end: register an asset, issue it to an employee,
   transfer and return it, log a repair, run a physical audit, raise and approve a purchase
   request through to a goods receipt, run an exit clearance, pull a financial report.
5. Record every defect found, however small, in a defect log with severity and reproduction steps.

**Gate to Stage 2**: all severity-1/2 defects from Stage 1 are fixed and re-verified; the business
owner has personally exercised at least the issue/return and the purchase-approval workflows.

## Stage 2 — Pre-migration reconciliation (only if legacy data is being carried over, B5)
1. Run the legacy migration tool in `plan` (dry-run) mode against a **copy** of the real legacy
   SQLite database (never the live file — the tool opens it read-only regardless, but operate on a
   copy as a matter of process discipline).
2. The business owner (not engineering) reviews the dry-run report: what will be inserted, what
   will be skipped (including anything caught by the demo/test-data pattern — confirm nothing real
   was caught, and nothing demo-like was missed), and what would be rejected as a conflict.
3. Reconcile discrepancies: fix the source data, adjust the demo-data pattern, or accept documented
   exclusions (teams/workstations/pools, audit history, legacy passwords — see DECISIONS.md D47)
   in writing.
4. Only after written business approval of the reconciled plan: run `apply`, then `verify`, and
   have a second person (not whoever ran `apply`) review the verification report.

**Gate to Stage 3**: a signed-off verification report, or a decision not to migrate legacy data at
all (manual re-entry instead) — both are acceptable outcomes of this stage.

## Stage 3 — Role and permission setup
1. Configure the real organizational roles against the actual permission catalog (not the seeded
   templates verbatim, unless they already match) — least privilege per TAS §6.
2. Configure the Super Admin account(s) — at least two, so a single person leaving does not lock
   the organization out of administration (the system already refuses to deactivate the last
   active Super Admin).
3. Configure the approval policy/policies for purchase requests with the business's real approval
   chain and thresholds (W6).

## Stage 4 — Staff training and support
1. Train each role group on its own workflows only (asset managers, procurement officers,
   approvers, IT technicians, HR/exit-clearance staff) — not a single all-hands session covering
   every screen.
2. Provide a support contact and an escalation path for the pilot period.
3. Walk through what each role will and will not be able to see (e.g., who can see acquisition
   cost, who can approve purchases) so permission-denied messages during the pilot are expected,
   not alarming.

## Stage 5 — Backup and recovery rehearsal (production topology)
1. Take a real backup of the staging/pilot database in the actual target topology.
2. Restore it into a separate, isolated environment (never over the live pilot data).
3. Verify as described in `docs/BACKUP_RECOVERY.md`, including at least one representative
   workflow against the restored copy.
4. Record the actual time taken against the provisional RTO (DECISIONS.md D47) and report any gap
   to the business owner — do not silently accept a worse-than-target result.

## Stage 6 — Go-live with real data
1. Only after every prior gate has passed and the business owner has given written authorization
   to use real BPO data.
2. Appropriate security controls from DECISIONS.md D47 must be in place first: HTTPS verified
   through the real proxy, production rate limits/lockout verified, restricted database/storage
   credentials, no development shortcuts.
3. Monitor closely for the first operational cycle (at least one full procurement cycle and one
   full audit cycle) before considering the pilot complete.

## Rollback criteria (any one triggers a pause, not necessarily a full rollback)
- A security finding classified medium or higher that cannot be mitigated within the pilot's risk
  tolerance.
- Data loss or a confirmed migration discrepancy discovered after go-live.
- A backup/restore rehearsal failure in the production topology that hasn't been re-verified.
- Sustained inability to meet the business-approved RPO/RTO.

## Sign-off requirements
Each stage gate above requires a named business-owner approval, recorded (even informally, e.g. in
an email or ticket) before proceeding to the next stage. Engineering readiness (tests passing,
code reviewed) is necessary but not sufficient on its own — this plan exists because production
readiness is a business decision as much as a technical one.
