/**
 * W9.7: server-side ingestion of local-pending offline audit observations and maintenance
 * requests (DECISIONS.md D50/D51). This is the first write path a disconnected desktop agent can
 * ever reach from the server's side, so it gets two independent layers of duplicate protection,
 * not one: the existing idempotency-key machinery (D36, 24h TTL) for the fast/common retry case,
 * and this migration's own permanent `offline_sync_uploads` table for a client record uploaded
 * again after that window has expired (a desktop agent may stay disconnected far longer than 24h).
 *
 * `offline_observation_records` is a new, honestly-named table -- it is NOT inserted into
 * `audit_items`/`physical_audits`. Those model a server-opened audit with its own frozen snapshot
 * and discrepancy-resolution workflow; an offline observation was never opened against one, and
 * forcing it into that shape would misrepresent what actually happened (TAS/D48 "do not invent
 * incompatible business semantics"). A maintenance request, by contrast, maps directly onto the
 * real `maintenance_tickets` table via the existing `createTicket` service -- no new table for it.
 */
export const migration0010 = {
  version: 10,
  name: 'offline_sync',
  sql: `
CREATE TABLE offline_observation_records (
  id                          uuid PRIMARY KEY,
  organization_id             uuid NOT NULL REFERENCES organizations(id),
  lease_id                    uuid NOT NULL,
  device_id                   uuid NOT NULL,
  user_id                     uuid NOT NULL,
  asset_id                    uuid NOT NULL,
  observation_type            text NOT NULL CHECK (observation_type IN ('verified', 'missing')),
  observed_condition          text,
  matches_expected_condition  boolean,
  notes                       text,
  client_observed_at          timestamptz NOT NULL,
  fencing_epoch               bigint NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, lease_id) REFERENCES offline_leases(organization_id, id),
  FOREIGN KEY (organization_id, device_id) REFERENCES sync_devices(organization_id, id),
  FOREIGN KEY (organization_id, user_id) REFERENCES users(organization_id, id),
  FOREIGN KEY (organization_id, asset_id) REFERENCES assets(organization_id, id)
);
CREATE INDEX idx_offline_observation_records_asset ON offline_observation_records(organization_id, asset_id);
CREATE INDEX idx_offline_observation_records_lease ON offline_observation_records(organization_id, lease_id);

-- Permanent record of "this client-generated record id became this server entity", independent of
-- the idempotency-key table's 24h TTL (D36). The actual duplicate-prevention invariant for this
-- phase: one client_record_id can never produce two server entities, enforced by the UNIQUE index,
-- not by application code alone.
CREATE TABLE offline_sync_uploads (
  id                  uuid PRIMARY KEY,
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  client_record_id    uuid NOT NULL,
  record_type         text NOT NULL CHECK (record_type IN ('observation', 'maintenance_request')),
  lease_id            uuid NOT NULL,
  device_id           uuid NOT NULL,
  user_id             uuid NOT NULL,
  server_entity_type  text NOT NULL,
  server_entity_id    uuid NOT NULL,
  uploaded_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, client_record_id),
  FOREIGN KEY (organization_id, lease_id) REFERENCES offline_leases(organization_id, id),
  FOREIGN KEY (organization_id, device_id) REFERENCES sync_devices(organization_id, id),
  FOREIGN KEY (organization_id, user_id) REFERENCES users(organization_id, id)
);
`
}
