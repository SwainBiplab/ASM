/**
 * W9.5 (audit-observations slice): purely local, unsynced audit observations recorded against the
 * frozen lease-scoped snapshot -- `verifyItem`/`flagMissing` terminology reused from the cloud
 * audit module (`src/shared/auditSchemas.ts`), but these rows are never a server audit record.
 * `sync_status` is deliberately CHECK-constrained to the single value `'local_pending'` today: this
 * slice does not upload or synchronize anything (hard boundary), so the schema itself refuses to
 * represent a "synced"/"confirmed" state that doesn't exist yet -- a future sync phase adds those
 * values via a new migration, never by editing this one.
 *
 * `snapshot_id` (new on `local_sync_state`, generated fresh by every download) is what lets a
 * recorded-but-now-stale observation be told apart from one made against the current cache: the
 * renderer captures the snapshot id when it loads the list, and an observation submitted against a
 * since-replaced snapshot is rejected rather than silently recorded against the wrong generation.
 */
export const migration0004 = {
  version: 4,
  name: 'observations',
  sql: `
ALTER TABLE local_sync_state ADD COLUMN snapshot_id TEXT;

CREATE TABLE local_audit_observations (
  id                        TEXT PRIMARY KEY,
  scope_lease_id            TEXT NOT NULL,
  snapshot_id               TEXT NOT NULL,
  asset_id                  TEXT NOT NULL,
  asset_code                TEXT NOT NULL,
  observation_type          TEXT NOT NULL CHECK (observation_type IN ('verified', 'missing')),
  observed_condition        TEXT,
  matches_cached_condition  INTEGER,
  notes                     TEXT,
  observed_at               TEXT NOT NULL,
  sync_status               TEXT NOT NULL DEFAULT 'local_pending' CHECK (sync_status = 'local_pending')
) STRICT;
CREATE INDEX idx_local_observations_asset ON local_audit_observations(asset_id);
CREATE INDEX idx_local_observations_lease ON local_audit_observations(scope_lease_id);
`
}
