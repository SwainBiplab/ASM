/**
 * W9.3 phase 1 local schema: the device's own local identity only. Deliberately not the
 * prototype's schema (CLAUDE.md: "never reuse the prototype's own SQLite schema, migrations, or
 * local database") and not a business schema -- no leases, outbox, or cached domain data exist
 * yet (W9.4+). `local_device_id` is generated once on first run and is NOT the server's
 * `sync_devices.device_uuid` until enrollment (a future phase) records that mapping.
 */
export const migration0001 = {
  version: 1,
  name: 'foundation',
  sql: `
CREATE TABLE local_device (
  id          TEXT PRIMARY KEY,
  singleton   INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1),
  created_at  TEXT NOT NULL
) STRICT;
`
}
