/**
 * Operational readiness (W8, TAS §7/§21): a `scan_failed` document state distinct from
 * `quarantined` (scanner errored vs. scanner found a problem), and a durable checkpoint table so
 * the legacy SQLite migration tool can be interrupted and retried without duplicating records.
 */
export const migration0008 = {
  version: 8,
  name: 'ops',
  sql: `
ALTER TABLE documents DROP CONSTRAINT documents_scan_status_check;
ALTER TABLE documents ADD CONSTRAINT documents_scan_status_check CHECK (scan_status IN ('not_scanned', 'pending', 'clean', 'rejected', 'quarantined', 'scan_failed'));

-- One row per successfully migrated legacy record, keyed by where it came from. The migration
-- tool checks this before inserting, so re-running an interrupted or re-applied migration is a
-- no-op for anything already recorded here, never a duplicate insert.
CREATE TABLE legacy_migration_records (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  source_table    text NOT NULL,
  source_id       text NOT NULL,
  target_table    text NOT NULL,
  target_id       uuid NOT NULL,
  migrated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, source_table, source_id)
);
CREATE INDEX idx_legacy_migration_target ON legacy_migration_records(organization_id, target_table, target_id);
`
}
