/**
 * W9.5 (continued): purely local, unsynced maintenance requests against the frozen lease-scoped
 * snapshot. Reuses the cloud maintenance module's terminology (`fault_category`, `priority`,
 * `description` -- see `src/shared/maintenance.ts`/`maintenanceSchemas.ts`'s `createTicketSchema`),
 * but this is deliberately a smaller, request-only shape: no technician assignment, vendor info, or
 * duplicate-ticket detection, since those depend on server-side state (other open tickets, active
 * technicians) this process has no way to see offline. `sync_status` is CHECK-constrained to the
 * single value `'local_pending'` for the same reason as `local_audit_observations`: this slice does
 * not upload or synchronize anything, so the schema itself cannot represent a confirmed ticket.
 */
export const migration0005 = {
  version: 5,
  name: 'maintenance_requests',
  sql: `
CREATE TABLE local_maintenance_requests (
  id              TEXT PRIMARY KEY,
  scope_lease_id  TEXT NOT NULL,
  snapshot_id     TEXT NOT NULL,
  asset_id        TEXT NOT NULL,
  asset_code      TEXT NOT NULL,
  fault_category  TEXT NOT NULL CHECK (fault_category IN ('hardware', 'software', 'electrical', 'mechanical', 'cosmetic', 'other')),
  priority        TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  description     TEXT NOT NULL,
  requested_at    TEXT NOT NULL,
  sync_status     TEXT NOT NULL DEFAULT 'local_pending' CHECK (sync_status = 'local_pending')
) STRICT;
CREATE INDEX idx_local_maintenance_asset ON local_maintenance_requests(asset_id);
CREATE INDEX idx_local_maintenance_lease ON local_maintenance_requests(scope_lease_id);
`
}
