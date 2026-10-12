/**
 * Maintenance tickets and physical audits (W5, TAS §11, §13, §16.6). Maintenance keeps its own
 * append-only event history, separate from asset_movements (TAS §11.2: "a maintenance ticket
 * remains a distinct record"). Physical audits freeze an expected-inventory snapshot at creation
 * time; later edits to the master asset record never retroactively change what was expected.
 */
export const migration0006 = {
  version: 6,
  name: 'maintenance_audits',
  sql: `
-- A composite unique key lets other tables reference a specific movement by (organization_id, id),
-- matching the FK convention used everywhere else; asset_movements predates this need (W4).
ALTER TABLE asset_movements ADD CONSTRAINT asset_movements_org_id_unique UNIQUE (organization_id, id);

CREATE TABLE w5_counters (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  next_ticket     bigint NOT NULL DEFAULT 1 CHECK (next_ticket >= 1),
  next_audit      bigint NOT NULL DEFAULT 1 CHECK (next_audit >= 1)
);

CREATE TABLE maintenance_tickets (
  id                      uuid PRIMARY KEY,
  organization_id         uuid NOT NULL REFERENCES organizations(id),
  ticket_number           text NOT NULL,
  asset_id                uuid NOT NULL,
  fault_category          text NOT NULL CHECK (fault_category IN ('hardware', 'software', 'electrical', 'mechanical', 'cosmetic', 'other')),
  priority                text NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  description             text NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  status                  text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed', 'cancelled')),
  reported_by             uuid NOT NULL,
  reported_at             timestamptz NOT NULL DEFAULT now(),
  assigned_technician_id  uuid,
  assigned_at             timestamptz,
  vendor_name             text,
  vendor_reference        text,
  target_resolution_date  date,
  diagnosis               text,
  work_performed          text,
  parts_cost_minor        bigint CHECK (parts_cost_minor IS NULL OR parts_cost_minor >= 0),
  labor_cost_minor        bigint CHECK (labor_cost_minor IS NULL OR labor_cost_minor >= 0),
  currency                char(3),
  downtime_minutes        integer CHECK (downtime_minutes IS NULL OR downtime_minutes >= 0),
  resolved_at             timestamptz,
  closed_at               timestamptz,
  closed_by               uuid,
  result_outcome          text CHECK (result_outcome IS NULL OR result_outcome IN ('ready', 'awaiting_inspection', 'non_operational')),
  closing_notes           text,
  cancel_reason           text,
  /** True for a deliberately authorized second open ticket on an asset that already has one (see the partial index below). */
  justified_duplicate     boolean NOT NULL DEFAULT false,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, ticket_number),
  FOREIGN KEY (organization_id, asset_id) REFERENCES assets(organization_id, id),
  FOREIGN KEY (organization_id, reported_by) REFERENCES users(organization_id, id),
  FOREIGN KEY (organization_id, assigned_technician_id) REFERENCES users(organization_id, id),
  FOREIGN KEY (organization_id, closed_by) REFERENCES users(organization_id, id),
  CHECK ((status IN ('closed', 'cancelled')) = (closed_at IS NOT NULL)),
  CHECK (status <> 'closed' OR (closed_by IS NOT NULL AND result_outcome IS NOT NULL)),
  CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL),
  CHECK (status NOT IN ('resolved', 'closed') OR resolved_at IS NOT NULL)
);
-- At most one accidental duplicate per asset: an honestly-opened second ticket while the first is
-- still open/in_progress is blocked, but an explicitly justified one (flag set, authorized,
-- reasoned — enforced in the service layer) is not covered by this index at all.
CREATE UNIQUE INDEX one_open_ticket_per_asset ON maintenance_tickets(asset_id) WHERE status IN ('open', 'in_progress') AND NOT justified_duplicate;
CREATE INDEX idx_tickets_asset ON maintenance_tickets(organization_id, asset_id, reported_at DESC);
CREATE INDEX idx_tickets_status ON maintenance_tickets(organization_id, status);
CREATE INDEX idx_tickets_technician ON maintenance_tickets(organization_id, assigned_technician_id) WHERE assigned_technician_id IS NOT NULL;

CREATE TABLE maintenance_ticket_events (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  seq             bigint GENERATED ALWAYS AS IDENTITY,
  ticket_id       uuid NOT NULL,
  event_type      text NOT NULL CHECK (event_type IN ('created', 'assigned', 'updated', 'resolved', 'closed', 'cancelled')),
  actor_user_id   uuid NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  notes           text,
  FOREIGN KEY (organization_id, ticket_id) REFERENCES maintenance_tickets(organization_id, id),
  FOREIGN KEY (organization_id, actor_user_id) REFERENCES users(organization_id, id)
);
CREATE INDEX idx_ticket_events_ticket ON maintenance_ticket_events(organization_id, ticket_id, seq);
-- Chronological service history; never overwritten (TAS §11.2).
CREATE FUNCTION maintenance_ticket_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'maintenance ticket events are append-only'; END $$;
CREATE TRIGGER maintenance_ticket_events_no_change BEFORE UPDATE OR DELETE ON maintenance_ticket_events FOR EACH ROW EXECUTE FUNCTION maintenance_ticket_events_append_only();
CREATE TRIGGER maintenance_ticket_events_no_truncate BEFORE TRUNCATE ON maintenance_ticket_events FOR EACH STATEMENT EXECUTE FUNCTION maintenance_ticket_events_append_only();

CREATE TABLE physical_audits (
  id                        uuid PRIMARY KEY,
  organization_id           uuid NOT NULL REFERENCES organizations(id),
  audit_number              text NOT NULL,
  title                     text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  notes                     text,
  scope_mode                text NOT NULL CHECK (scope_mode IN ('criteria', 'selected')),
  scope_location_id         uuid,
  scope_category_id         uuid,
  scope_custodian_employee_id uuid,
  responsible_user_id       uuid NOT NULL,
  status                    text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  closure_type              text CHECK (closure_type IS NULL OR closure_type IN ('fully_verified', 'with_exceptions')),
  opened_by                 uuid NOT NULL,
  opened_at                 timestamptz NOT NULL DEFAULT now(),
  closed_by                 uuid,
  closed_at                 timestamptz,
  closing_notes             text,
  cancel_reason             text,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, audit_number),
  FOREIGN KEY (organization_id, scope_location_id) REFERENCES locations(organization_id, id),
  FOREIGN KEY (organization_id, scope_category_id) REFERENCES asset_categories(organization_id, id),
  FOREIGN KEY (organization_id, scope_custodian_employee_id) REFERENCES employees(organization_id, id),
  FOREIGN KEY (organization_id, responsible_user_id) REFERENCES users(organization_id, id),
  FOREIGN KEY (organization_id, opened_by) REFERENCES users(organization_id, id),
  FOREIGN KEY (organization_id, closed_by) REFERENCES users(organization_id, id),
  CHECK ((status = 'open') = (closed_at IS NULL)),
  CHECK (status <> 'closed' OR closure_type IS NOT NULL),
  CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL)
);

CREATE TABLE audit_items (
  id                       uuid PRIMARY KEY,
  organization_id          uuid NOT NULL REFERENCES organizations(id),
  audit_id                 uuid NOT NULL,
  asset_id                 uuid NOT NULL,
  source                   text NOT NULL CHECK (source IN ('expected', 'unexpected')),
  -- Frozen baseline (TAS §13: must not change silently once the audit has begun). NULL for an
  -- 'unexpected' row, which by definition had no expectation recorded at snapshot time.
  expected_location_id     uuid,
  expected_location_path   text,
  expected_condition       text CHECK (expected_condition IS NULL OR expected_condition IN ('new', 'good', 'fair', 'damaged', 'unknown')),
  expected_custodian_label text,
  -- Observation, filled in by a scan or manual lookup.
  observed_at              timestamptz,
  observed_by              uuid,
  observed_location_id     uuid,
  observed_condition       text CHECK (observed_condition IS NULL OR observed_condition IN ('new', 'good', 'fair', 'damaged', 'unknown')),
  notes                    text,
  status                   text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'discrepancy_open', 'investigating', 'resolved', 'accepted')),
  discrepancy_type         text CHECK (discrepancy_type IS NULL OR discrepancy_type IN ('missing', 'unexpected', 'location_mismatch', 'condition_mismatch', 'identification_mismatch')),
  assigned_to              uuid,
  assignment_notes         text,
  resolution_notes         text,
  resolved_by              uuid,
  resolved_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  -- One row per asset per audit: a re-scan updates the existing row, it never creates a second one.
  UNIQUE (audit_id, asset_id),
  FOREIGN KEY (organization_id, audit_id) REFERENCES physical_audits(organization_id, id),
  FOREIGN KEY (organization_id, asset_id) REFERENCES assets(organization_id, id),
  FOREIGN KEY (organization_id, expected_location_id) REFERENCES locations(organization_id, id),
  FOREIGN KEY (organization_id, observed_location_id) REFERENCES locations(organization_id, id),
  FOREIGN KEY (organization_id, observed_by) REFERENCES users(organization_id, id),
  FOREIGN KEY (organization_id, assigned_to) REFERENCES users(organization_id, id),
  FOREIGN KEY (organization_id, resolved_by) REFERENCES users(organization_id, id),
  CHECK (source = 'expected' OR (expected_location_id IS NULL AND expected_condition IS NULL)),
  CHECK (status <> 'pending' OR observed_at IS NULL),
  -- 'missing' is the one discrepancy that is never actually observed.
  CHECK (discrepancy_type <> 'missing' OR observed_at IS NULL),
  CHECK (discrepancy_type IS NULL OR discrepancy_type = 'missing' OR observed_at IS NOT NULL)
);
CREATE INDEX idx_audit_items_audit ON audit_items(organization_id, audit_id, status);
CREATE INDEX idx_audit_items_asset ON audit_items(organization_id, asset_id);

-- Maintenance tickets and audit items can own evidence documents (repair/audit evidence).
ALTER TABLE document_links DROP CONSTRAINT document_links_entity_type_check;
ALTER TABLE document_links ADD CONSTRAINT document_links_entity_type_check CHECK (entity_type IN ('asset', 'handover', 'clearance_item', 'maintenance_ticket', 'audit_item'));

-- New permission; existing template roles receive it like newly bootstrapped organizations would.
INSERT INTO permissions (key, description) VALUES
  ('audits.verify', 'Scan and verify assets during a physical audit')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r JOIN (VALUES
  ('super_admin', 'audits.verify'), ('asset_manager', 'audits.verify'),
  ('it_technician', 'audits.verify'), ('it_technician', 'audits.view'),
  ('facilities_manager', 'audits.verify'), ('facilities_manager', 'audits.view')
) AS p(role_key, key) ON p.role_key = r.key
ON CONFLICT DO NOTHING;
`
}
