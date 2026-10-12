/**
 * Allocation, custody history, handover acknowledgment and exit clearance (W4, TAS §9–§10, §16.4,
 * §16.7, §16.9). Assignment state stays derived from assignment rows; assets keep no "assigned" flag.
 *
 * Invariants enforced by the database (the services also check them, with row locks):
 *  - exactly one target per assignment/handover, matching its target type;
 *  - at most one active assignment per asset (partial unique index);
 *  - closed assignments are immutable and no assignment is ever deleted;
 *  - movements are append-only; at most one open exit clearance per employee.
 */
const target = (alias: string) => `
  CHECK (num_nonnulls(employee_id, workstation_id, department_id, team_id, pool_id) = ${alias === 'handovers' ? "(CASE WHEN target_type IS NULL THEN 0 ELSE 1 END)" : '1'}),
  CHECK (target_type IS NULL OR CASE target_type
    WHEN 'employee' THEN employee_id IS NOT NULL
    WHEN 'workstation' THEN workstation_id IS NOT NULL
    WHEN 'department' THEN department_id IS NOT NULL
    WHEN 'team' THEN team_id IS NOT NULL
    WHEN 'pool' THEN pool_id IS NOT NULL END),
  FOREIGN KEY (organization_id, employee_id) REFERENCES employees(organization_id, id),
  FOREIGN KEY (organization_id, workstation_id) REFERENCES workstations(organization_id, id),
  FOREIGN KEY (organization_id, department_id) REFERENCES departments(organization_id, id),
  FOREIGN KEY (organization_id, team_id) REFERENCES teams(organization_id, id),
  FOREIGN KEY (organization_id, pool_id) REFERENCES asset_pools(organization_id, id),
  FOREIGN KEY (organization_id, location_id) REFERENCES locations(organization_id, id)`
const targetColumns = `
  employee_id     uuid,
  workstation_id  uuid,
  department_id   uuid,
  team_id         uuid,
  pool_id         uuid,
  location_id     uuid,`

export const migration0005 = {
  version: 5,
  name: 'allocations',
  sql: `
-- Per-organization counters for human-readable handover and clearance numbers (row-locked by UPDATE).
CREATE TABLE allocation_counters (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  next_handover   bigint NOT NULL DEFAULT 1 CHECK (next_handover >= 1),
  next_clearance  bigint NOT NULL DEFAULT 1 CHECK (next_clearance >= 1)
);

CREATE TABLE handovers (
  id                    uuid PRIMARY KEY,
  organization_id       uuid NOT NULL REFERENCES organizations(id),
  handover_number       text NOT NULL,
  handover_type         text NOT NULL CHECK (handover_type IN ('issue', 'transfer', 'return')),
  target_type           text CHECK (target_type IN ('employee', 'workstation', 'department', 'team', 'pool')),${targetColumns}
  performed_at          timestamptz NOT NULL DEFAULT now(),
  performed_by          uuid NOT NULL,
  reason                text,
  notes                 text,
  ack_policy            text NOT NULL CHECK (ack_policy IN ('in_app', 'signed_receipt', 'in_app_or_signed')),
  ack_status            text NOT NULL CHECK (ack_status IN ('not_required', 'pending', 'acknowledged')),
  ack_method            text CHECK (ack_method IN ('in_app', 'signed_receipt')),
  acknowledged_by_name  text,
  acknowledged_at       timestamptz,
  ack_recorded_by       uuid,
  ack_document_id       uuid,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, handover_number),
  FOREIGN KEY (organization_id, performed_by) REFERENCES users(organization_id, id),
  FOREIGN KEY (organization_id, ack_recorded_by) REFERENCES users(organization_id, id),
  FOREIGN KEY (organization_id, ack_document_id) REFERENCES documents(organization_id, id),
  CHECK ((handover_type = 'return') = (target_type IS NULL)),
  CHECK (handover_type <> 'transfer' OR reason IS NOT NULL),
  CHECK ((ack_status = 'acknowledged') = (ack_method IS NOT NULL AND acknowledged_at IS NOT NULL AND ack_recorded_by IS NOT NULL)),
  CHECK (ack_method <> 'in_app' OR acknowledged_by_name IS NOT NULL),
  CHECK (ack_method <> 'signed_receipt' OR ack_document_id IS NOT NULL),${target('handovers')}
);

CREATE TABLE handover_items (
  handover_id     uuid NOT NULL REFERENCES handovers(id),
  organization_id uuid NOT NULL,
  asset_id        uuid NOT NULL,
  condition       text NOT NULL CHECK (condition IN ('new', 'good', 'fair', 'damaged', 'unknown')),
  accessories     text,
  outcome         text CHECK (outcome IN ('ready', 'awaiting_inspection', 'non_operational')),
  notes           text,
  PRIMARY KEY (handover_id, asset_id),
  FOREIGN KEY (organization_id, asset_id) REFERENCES assets(organization_id, id)
);

CREATE TABLE asset_assignments (
  id                   uuid PRIMARY KEY,
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  asset_id             uuid NOT NULL,
  target_type          text NOT NULL CHECK (target_type IN ('employee', 'workstation', 'department', 'team', 'pool')),${targetColumns}
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'returned', 'transferred', 'lost')),
  assigned_at          timestamptz NOT NULL DEFAULT now(),
  issued_by            uuid NOT NULL,
  issue_handover_id    uuid NOT NULL,
  expected_return_date date,
  condition_at_issue   text NOT NULL CHECK (condition_at_issue IN ('new', 'good', 'fair', 'damaged', 'unknown')),
  accessories          text,
  ended_at             timestamptz,
  ended_by             uuid,
  end_handover_id      uuid,
  condition_at_return  text CHECK (condition_at_return IN ('new', 'good', 'fair', 'damaged', 'unknown')),
  return_outcome       text CHECK (return_outcome IN ('ready', 'awaiting_inspection', 'non_operational')),
  end_reason           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, asset_id) REFERENCES assets(organization_id, id),
  FOREIGN KEY (organization_id, issued_by) REFERENCES users(organization_id, id),
  FOREIGN KEY (organization_id, ended_by) REFERENCES users(organization_id, id),
  FOREIGN KEY (organization_id, issue_handover_id) REFERENCES handovers(organization_id, id),
  FOREIGN KEY (organization_id, end_handover_id) REFERENCES handovers(organization_id, id),
  CHECK ((status = 'active') = (ended_at IS NULL)),
  CHECK (status = 'active' OR ended_by IS NOT NULL),
  CHECK (status NOT IN ('returned', 'transferred') OR end_handover_id IS NOT NULL),
  CHECK (status <> 'lost' OR end_reason IS NOT NULL),
  CHECK (ended_at IS NULL OR ended_at >= assigned_at),${target('asset_assignments')}
);
-- TAS §9.3 / §16.9: the database itself refuses a second active assignment for an asset.
CREATE UNIQUE INDEX one_active_assignment_per_asset ON asset_assignments(asset_id) WHERE status = 'active';
CREATE INDEX idx_assignments_asset ON asset_assignments(organization_id, asset_id, assigned_at DESC);
CREATE INDEX idx_assignments_employee_active ON asset_assignments(organization_id, employee_id) WHERE status = 'active';
CREATE INDEX idx_assignments_status ON asset_assignments(organization_id, status);

-- History is never rewritten: a closed assignment is frozen and assignments are never deleted.
CREATE FUNCTION asset_assignments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'asset assignments are never deleted'; END IF;
  IF OLD.status <> 'active' THEN RAISE EXCEPTION 'a closed assignment cannot be changed'; END IF;
  IF NEW.id <> OLD.id OR NEW.asset_id <> OLD.asset_id OR NEW.organization_id <> OLD.organization_id OR NEW.target_type <> OLD.target_type
     OR NEW.assigned_at <> OLD.assigned_at OR NEW.issue_handover_id <> OLD.issue_handover_id
     OR NEW.employee_id IS DISTINCT FROM OLD.employee_id OR NEW.workstation_id IS DISTINCT FROM OLD.workstation_id
     OR NEW.department_id IS DISTINCT FROM OLD.department_id OR NEW.team_id IS DISTINCT FROM OLD.team_id OR NEW.pool_id IS DISTINCT FROM OLD.pool_id THEN
    RAISE EXCEPTION 'assignment identity and target are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER asset_assignments_guard BEFORE UPDATE OR DELETE ON asset_assignments FOR EACH ROW EXECUTE FUNCTION asset_assignments_guard();

CREATE TABLE asset_movements (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  seq             bigint GENERATED ALWAYS AS IDENTITY,
  asset_id        uuid NOT NULL,
  movement_type   text NOT NULL CHECK (movement_type IN ('issued', 'transferred', 'returned', 'inspected', 'reported_lost')),
  assignment_id   uuid,
  handover_id     uuid,
  location_id     uuid,
  actor_user_id   uuid NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  notes           text,
  FOREIGN KEY (organization_id, asset_id) REFERENCES assets(organization_id, id),
  FOREIGN KEY (organization_id, assignment_id) REFERENCES asset_assignments(organization_id, id),
  FOREIGN KEY (organization_id, handover_id) REFERENCES handovers(organization_id, id),
  FOREIGN KEY (organization_id, location_id) REFERENCES locations(organization_id, id),
  FOREIGN KEY (organization_id, actor_user_id) REFERENCES users(organization_id, id)
);
CREATE INDEX idx_movements_asset ON asset_movements(organization_id, asset_id, seq);
CREATE FUNCTION asset_movements_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'asset movements are append-only'; END $$;
CREATE TRIGGER asset_movements_no_change BEFORE UPDATE OR DELETE ON asset_movements FOR EACH ROW EXECUTE FUNCTION asset_movements_append_only();
CREATE TRIGGER asset_movements_no_truncate BEFORE TRUNCATE ON asset_movements FOR EACH STATEMENT EXECUTE FUNCTION asset_movements_append_only();

CREATE TABLE exit_clearances (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  clearance_number text NOT NULL,
  employee_id      uuid NOT NULL,
  exit_date        date NOT NULL,
  owner_user_id    uuid NOT NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  closure_type     text CHECK (closure_type IN ('cleared', 'with_exceptions')),
  notes            text,
  opened_by        uuid NOT NULL,
  opened_at        timestamptz NOT NULL DEFAULT now(),
  closed_by        uuid,
  closed_at        timestamptz,
  closing_notes    text,
  cancel_reason    text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, clearance_number),
  FOREIGN KEY (organization_id, employee_id) REFERENCES employees(organization_id, id),
  FOREIGN KEY (organization_id, owner_user_id) REFERENCES users(organization_id, id),
  FOREIGN KEY (organization_id, opened_by) REFERENCES users(organization_id, id),
  FOREIGN KEY (organization_id, closed_by) REFERENCES users(organization_id, id),
  CHECK ((status = 'open') = (closed_at IS NULL)),
  CHECK ((status = 'closed') = (closure_type IS NOT NULL)),
  CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL)
);
CREATE UNIQUE INDEX one_open_clearance_per_employee ON exit_clearances(employee_id) WHERE status = 'open';

CREATE TABLE exit_clearance_items (
  id                 uuid PRIMARY KEY,
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  clearance_id       uuid NOT NULL,
  asset_id           uuid NOT NULL,
  assignment_id      uuid NOT NULL,
  resolution         text NOT NULL DEFAULT 'outstanding' CHECK (resolution IN ('outstanding', 'returned', 'damaged', 'missing', 'disputed', 'exception_approved')),
  received_condition text CHECK (received_condition IN ('new', 'good', 'fair', 'damaged', 'unknown')),
  return_outcome     text CHECK (return_outcome IN ('ready', 'awaiting_inspection', 'non_operational')),
  return_handover_id uuid,
  exception_type     text CHECK (exception_type IN ('damaged', 'missing', 'disputed')),
  exception_reason   text,
  reported_by        uuid,
  reported_at        timestamptz,
  decision_notes     text,
  reviewed_by        uuid,
  reviewed_at        timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (clearance_id, assignment_id),
  FOREIGN KEY (organization_id, clearance_id) REFERENCES exit_clearances(organization_id, id),
  FOREIGN KEY (organization_id, asset_id) REFERENCES assets(organization_id, id),
  FOREIGN KEY (organization_id, assignment_id) REFERENCES asset_assignments(organization_id, id),
  FOREIGN KEY (organization_id, return_handover_id) REFERENCES handovers(organization_id, id),
  FOREIGN KEY (organization_id, reported_by) REFERENCES users(organization_id, id),
  FOREIGN KEY (organization_id, reviewed_by) REFERENCES users(organization_id, id),
  CHECK (resolution NOT IN ('missing', 'disputed') OR (exception_reason IS NOT NULL AND reported_by IS NOT NULL)),
  CHECK (resolution <> 'exception_approved' OR (decision_notes IS NOT NULL AND reviewed_by IS NOT NULL AND exception_type IS NOT NULL))
);
CREATE INDEX idx_clearance_items ON exit_clearance_items(clearance_id);

-- Handovers and clearance items can own documents (signed receipts, loss/damage evidence).
ALTER TABLE document_links DROP CONSTRAINT document_links_entity_type_check;
ALTER TABLE document_links ADD CONSTRAINT document_links_entity_type_check CHECK (entity_type IN ('asset', 'handover', 'clearance_item'));

-- New permissions; existing template roles receive them like newly bootstrapped organizations would.
INSERT INTO permissions (key, description) VALUES
  ('allocations.view', 'View assignments, handovers and custody history'),
  ('allocations.inspect', 'Inspect returned assets and release them for reuse')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r JOIN (VALUES
  ('super_admin', 'allocations.view'), ('super_admin', 'allocations.inspect'),
  ('asset_manager', 'allocations.view'), ('asset_manager', 'allocations.inspect'),
  ('it_technician', 'allocations.view'), ('it_technician', 'allocations.inspect'),
  ('facilities_manager', 'allocations.view'), ('auditor', 'allocations.view')
) AS p(role_key, key) ON p.role_key = r.key
ON CONFLICT DO NOTHING;
`
}
