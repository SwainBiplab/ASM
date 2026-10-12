# Backup and recovery procedure (W8)

See DECISIONS.md D47 for the full classification of open decisions this depends on (B6 RPO/RTO,
U4 provider). This document is the operational procedure; it does not itself authorize any
RPO/RTO target as business-approved.

## What is backed up

1. **PostgreSQL data** — the authoritative store for every business record.
2. **Object storage documents** — uploaded files (invoices, photos, evidence). A managed S3-compatible
   provider's own bucket versioning/replication should be enabled once a provider is chosen
   (DECISIONS.md D47); this procedure covers the database only today.
3. **Application configuration and secrets** — `.env` / the platform's secret store. Never commit
   these to the repository. Keep a copy in the organization's own secret manager (password vault,
   cloud secret manager), not in a plain file alongside backups.
4. **Migration reports and operational logs** — the legacy-migration tool's reports can name real
   employees/users; treat them like any other record containing personal data (see "Handling
   sensitive reports" below).

## Database backup

```
pg_dump --format=custom --no-owner --no-privileges --file=backup-$(date +%Y%m%d-%H%M).dump "$DATABASE_URL"
```

- Custom format (`--format=custom`) supports selective restore and is compressed by default.
- `--no-owner --no-privileges` avoids restore failures when the restoring role differs from the
  original (e.g. a different managed-Postgres instance).
- Schedule this daily at minimum (provisional RPO: 24 hours — see D47). A managed-PostgreSQL
  provider's built-in point-in-time recovery, if available, should supersede this manual schedule.
- Store the dump file encrypted at rest and access-restricted (database contents include
  acquisition costs, disposal proceeds, and employee personal data).

## Database restore (tested procedure)

```
# 1. Create an empty target database (never restore over a live database you intend to keep).
createdb "$TARGET_URL"

# 2. Restore.
pg_restore --no-owner --no-privileges --clean --if-exists --dbname="$TARGET_URL" backup-XXXXXXXX.dump

# 3. Verify before pointing the application at it (see "Verification after restore" below).
```

This exact `pg_dump`/`pg_restore` sequence is exercised by an automated test
(`tests/server/backup-restore.test.ts`) against a real, separate PostgreSQL database — not a
simulation. The test independently re-checks data, relationships, and role/permission grants
after restore, rather than trusting a zero exit code alone.

## Verification after restore

A completed `pg_restore` is not sufficient evidence recovery works. At minimum, verify:
- Row counts for a few key tables (`assets`, `employees`, `purchase_requests`) are plausible.
- A spot-checked record's relationships resolve (e.g. an asset's category, an employee's
  department) — a dangling foreign key after restore indicates a corrupted or partial dump.
- `role_permissions`/`roles` are present and a representative role (e.g. `super_admin`) still
  holds its expected permissions — a restore that silently drops grants is a security regression,
  not just a data-completeness one.
- At least one representative workflow actually runs against the restored database (sign in,
  search assets, open a purchase request) before declaring the restore usable.

## Recovery point/time objectives (provisional — not business-approved)

- **RPO: 24 hours** (daily dump). Reduce this only by adopting a managed provider's continuous
  backup/point-in-time recovery, or by increasing dump frequency (at the cost of load on the
  production database during the dump window).
- **RTO: 4 hours**, assuming a replacement database can be provisioned and the latest dump
  restored within that window, plus re-pointing `DATABASE_URL` and redeploying the application
  container.
- These are starting points for a business-owner conversation (TAS requires this explicitly), not
  guarantees. Record the business-approved figures in DECISIONS.md once set.

## Handling sensitive reports

Legacy-migration reports (`server:migrate-legacy`) and backup dumps can both contain real
employee/user names and financial figures. Do not commit them to the repository (already covered
by `.gitignore`'s `*.sqlite`/`/backups/` patterns — extend it if a different output path is used),
restrict filesystem permissions on wherever they are written (the CLI writes report files with
mode `0600` when `--report <path>` is given), and delete them once no longer needed for the
migration's own audit trail.

## Offline lease fencing epoch and restore (W9.2, DECISIONS.md D49/G)

The `fencing_epoch_seq` sequence (migration `0009_offline_leases`) gives every granted offline lease
a monotonically increasing number, so a future desktop agent can tell a stale/reclaimed lease apart
from the current one. This is a genuine, real-concurrency-tested guarantee *between* backups — it is
**not yet restore-safe**, and that gap is deliberate scope for this phase, not an oversight:

- Restoring a `pg_dump`/`pg_restore` backup restores `fencing_epoch_seq` to its backed-up value too.
  If a lease was granted (and its epoch consumed) *after* the backup was taken, a restore can hand
  out that same epoch value again to a new lease, which a sufficiently sophisticated future client
  could in principle confuse with the old one.
- Closing this gap fully requires storing the sequence's high-water mark somewhere a routine
  `pg_dump` does not capture (e.g. a separate append-only ledger, or a provider's continuous-backup
  metadata) — an infrastructure decision beyond W9.2's server-code scope, since no desktop agent
  exists yet to exploit the gap and no synchronization protocol exists yet to specify this against.
- **Until that is built**, the manual operational step before any restore is:
  ```
  SELECT last_value FROM fencing_epoch_seq;   -- record this value before the restore
  ```
  and immediately after a restore, advance the sequence past every epoch issued since the backup
  (`SELECT setval('fencing_epoch_seq', <recorded value + a safety margin>, true)`), before allowing
  any new lease to be granted against the restored database.
- A diagnostic query to spot leases granted with an epoch at or below the restored sequence's
  current value (i.e. ones that are now un-distinguishable from a future duplicate) is a planned
  W9-phase CLI helper, not yet implemented; today the manual `SELECT last_value` step above is the
  only mitigation, and it is a recovery-runbook procedure, not an automated safeguard.

## Operational health checks

- `GET /api/health/live` — process is up.
- `GET /api/health/ready` — database is reachable and the schema is at the expected version
  (returns 503 `migrations_pending` if a migration was not applied before deploy, or 503
  `database_unavailable` if the database cannot be reached).
- Failed uploads: check the server log for the request's correlation ID (returned to the client in
  every error envelope) — document upload failures are logged with the reason (size limit, type
  rejection, storage failure) without leaking storage credentials.
- Authentication errors: repeated `INVALID_CREDENTIALS` for one account past the configured
  threshold locks that account (`locked_until`); repeated attempts from one IP are rate-limited
  independently (`LOGIN_RATE_LIMIT_PER_MINUTE`).
- Migration failures: `npm run server:migrate` fails loudly (non-zero exit, no partial schema
  change — each migration runs in its own transaction) rather than leaving the schema half-applied.
