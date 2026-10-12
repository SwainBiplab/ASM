/**
 * W9.2 server-side foundations (TAS W9 §4/§8, DECISIONS.md D48/D49): device enrollment, exclusive
 * offline write-authority leases, and asset-code range reservations. This migration adds the
 * schema only; no synchronization protocol, local outbox, or offline command execution exists yet
 * (W9.4/W9.5). A device with an active lease cannot yet do anything with it beyond what this
 * phase's RPC commands expose (request/release/force-reclaim) -- the point of W9.2 is that the
 * *reservation* is safe under real concurrency before any client exists to consume it.
 */
export const migration0009 = {
  version: 9,
  name: 'offline_leases',
  sql: `
-- Monotonically increasing across the whole database; identifies a specific granted lease so a
-- stale/reclaimed grant can never be mistaken for the current one (TAS §4.1 "fencing token").
-- Operational note (DECISIONS.md D49/G): restoring a PostgreSQL backup restores this sequence to
-- its backed-up value too. Until a later phase stores the high-water mark outside the routine
-- backup, an operator must record 'SELECT last_value FROM fencing_epoch_seq' before any restore
-- and bump the sequence past it immediately after (see docs/BACKUP_RECOVERY.md).
CREATE SEQUENCE fencing_epoch_seq;

CREATE TABLE sync_devices (
  id                 uuid PRIMARY KEY,
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  device_uuid        uuid NOT NULL,
  device_name        text NOT NULL CHECK (length(device_name) BETWEEN 1 AND 160),
  owner_user_id       uuid NOT NULL,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
  requested_at       timestamptz NOT NULL DEFAULT now(),
  requested_by       uuid NOT NULL,
  -- Administrator attestation, not a self-reported client flag (D49/B): what was actually checked
  -- (e.g. "BitLocker confirmed via IT asset tag APT-0042") is recorded in trust_notes by a human.
  trust_verified_at  timestamptz,
  trust_verified_by  uuid,
  trust_notes        text,
  revoked_at         timestamptz,
  revoked_by         uuid,
  revoke_reason      text,
  last_seen_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, device_uuid),
  FOREIGN KEY (organization_id, owner_user_id) REFERENCES users(organization_id, id),
  FOREIGN KEY (organization_id, requested_by) REFERENCES users(organization_id, id),
  FOREIGN KEY (organization_id, trust_verified_by) REFERENCES users(organization_id, id),
  FOREIGN KEY (organization_id, revoked_by) REFERENCES users(organization_id, id),
  CHECK (status <> 'active' OR (trust_verified_at IS NOT NULL AND trust_verified_by IS NOT NULL)),
  CHECK (status <> 'revoked' OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL))
);
CREATE INDEX idx_sync_devices_owner ON sync_devices(organization_id, owner_user_id);

CREATE TABLE offline_leases (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  device_id       uuid NOT NULL,
  -- The grantee; D49/E requires this same user can never force-reclaim this row (enforced in service).
  user_id         uuid NOT NULL,
  scope_type      text NOT NULL CHECK (scope_type IN ('asset', 'asset_code_range')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'released', 'reclaimed')),
  fencing_epoch   bigint NOT NULL,
  granted_at      timestamptz NOT NULL DEFAULT now(),
  granted_by      uuid NOT NULL,
  expires_at      timestamptz NOT NULL,
  released_at     timestamptz,
  released_by     uuid,
  reclaimed_at    timestamptz,
  reclaimed_by    uuid,
  reclaim_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (fencing_epoch),
  FOREIGN KEY (organization_id, device_id) REFERENCES sync_devices(organization_id, id),
  FOREIGN KEY (organization_id, user_id) REFERENCES users(organization_id, id),
  FOREIGN KEY (organization_id, granted_by) REFERENCES users(organization_id, id),
  FOREIGN KEY (organization_id, released_by) REFERENCES users(organization_id, id),
  FOREIGN KEY (organization_id, reclaimed_by) REFERENCES users(organization_id, id),
  CHECK (status <> 'released' OR (released_at IS NOT NULL AND released_by IS NOT NULL)),
  CHECK (status <> 'reclaimed' OR (reclaimed_at IS NOT NULL AND reclaimed_by IS NOT NULL AND reclaim_reason IS NOT NULL))
);
CREATE INDEX idx_offline_leases_device ON offline_leases(organization_id, device_id, status);
CREATE INDEX idx_offline_leases_user ON offline_leases(organization_id, user_id, status);

-- One row per leased entity. is_active is denormalized from the owning lease's status (kept in
-- sync by the service, in the same transaction) purely so a partial unique index can enforce "no
-- two active leases on the same asset" transactionally -- the same technique already used for
-- one_open_ticket_per_asset (W5) and one_pending_instance_per_entity (W6).
CREATE TABLE offline_lease_scopes (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  lease_id        uuid NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  asset_id        uuid,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, lease_id) REFERENCES offline_leases(organization_id, id),
  FOREIGN KEY (organization_id, asset_id) REFERENCES assets(organization_id, id)
);
CREATE UNIQUE INDEX one_active_lease_per_asset ON offline_lease_scopes(organization_id, asset_id) WHERE is_active AND asset_id IS NOT NULL;
CREATE INDEX idx_lease_scopes_lease ON offline_lease_scopes(organization_id, lease_id);
CREATE INDEX idx_lease_scopes_asset ON offline_lease_scopes(organization_id, asset_id) WHERE asset_id IS NOT NULL;

-- Format version lets a reservation record exactly which prefix/separator/padding it was made
-- under, so a later format change can be detected against outstanding reservations (D49/D).
ALTER TABLE asset_code_config ADD COLUMN format_version integer NOT NULL DEFAULT 1;

CREATE TABLE asset_code_reservations (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  lease_id        uuid NOT NULL,
  format_version  integer NOT NULL,
  prefix          text NOT NULL,
  separator       text NOT NULL,
  padding         integer NOT NULL,
  range_start     bigint NOT NULL CHECK (range_start >= 1),
  range_end       bigint NOT NULL CHECK (range_end > range_start),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, lease_id) REFERENCES offline_leases(organization_id, id)
);
CREATE INDEX idx_code_reservations_lease ON asset_code_reservations(organization_id, lease_id);
CREATE INDEX idx_code_reservations_org ON asset_code_reservations(organization_id);

-- New permissions (devices.manage / leases.manage / leases.force_reclaim already in the shared
-- catalog); existing templates receive leases.manage like any other newly-bootstrapped organization would.
INSERT INTO permissions (key, description) VALUES
  ('devices.manage', 'Enroll, verify trust, and revoke offline desktop agent devices'),
  ('leases.manage', 'Request and release exclusive offline work-authority leases on an enrolled, trusted device'),
  ('leases.force_reclaim', 'Force-reclaim another user''s offline lease as the designated recovery authority')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r JOIN (VALUES
  ('asset_manager', 'leases.manage'), ('it_technician', 'leases.manage')
) AS p(role_key, key) ON p.role_key = r.key
ON CONFLICT DO NOTHING;
`
}
