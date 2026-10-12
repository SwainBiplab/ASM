/**
 * W9.4: a read-only local snapshot of the asset list, for offline browsing only. Mirrors
 * `AssetListItem` (`@shared/api`) field-for-field so the existing cloud list screen's data shape
 * needs no translation when it is eventually wired to this local source (D48/D51 adapter plan).
 * No cost, document, or history data is cached here -- this is a list snapshot, not a full offline
 * copy of the asset register. `synced_at` lets the UI show "last synchronized" and flag staleness.
 */
export const migration0002 = {
  version: 2,
  name: 'assets_snapshot',
  sql: `
CREATE TABLE local_assets (
  id                  TEXT PRIMARY KEY,
  asset_code          TEXT NOT NULL,
  category_name       TEXT NOT NULL,
  asset_domain        TEXT NOT NULL,
  manufacturer        TEXT,
  model_name          TEXT,
  serial_number       TEXT,
  lifecycle_status    TEXT NOT NULL,
  operational_status  TEXT NOT NULL,
  condition           TEXT NOT NULL,
  location_path       TEXT,
  warranty_end        TEXT,
  updated_at          TEXT NOT NULL,
  synced_at           TEXT NOT NULL
) STRICT;

-- Singleton: one row records when the local snapshot was last replaced wholesale.
CREATE TABLE local_sync_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  last_synced_at  TEXT NOT NULL
) STRICT;
`
}
