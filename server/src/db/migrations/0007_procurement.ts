/**
 * Procurement, configurable approvals, purchase orders and goods receipt (W6, TAS §12).
 *
 * Approval policies are versioned by creating a new row per edit (never mutating a row that an
 * in-flight approval instance has already snapshotted): `policy_group_id` is the stable identity
 * of "the configured policy", `version` increments, and `is_current` marks the one version new
 * submissions resolve against. An `approval_instance` stores the exact `policy_id` (a specific
 * version) it was created from, so editing the policy later never changes an approval already
 * underway (TAS §12.2).
 *
 * Bulk-stock tracking did not exist before this migration; `asset_categories.tracking_mode =
 * 'bulk'` previously could not become inventory at all (see `resolveAssetRefs` in assets.ts,
 * which explicitly points at "procurement receipts" as the intended mechanism). This migration
 * adds the minimal ledger goods receipt needs (`stock_movements`, `bulk_stock_balances`) — it
 * does not resolve the open B2 business decision about bulk-category policy generally.
 */
export const migration0007 = {
  version: 7,
  name: 'procurement',
  sql: `
CREATE TABLE w6_counters (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  next_request    bigint NOT NULL DEFAULT 1 CHECK (next_request >= 1),
  next_po         bigint NOT NULL DEFAULT 1 CHECK (next_po >= 1),
  next_receipt    bigint NOT NULL DEFAULT 1 CHECK (next_receipt >= 1)
);

-- ---------------------------------------------------------------- purchase requests

CREATE TABLE purchase_requests (
  id                  uuid PRIMARY KEY,
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  request_number      text NOT NULL,
  requester_user_id   uuid NOT NULL,
  department_id       uuid,
  team_id             uuid,
  justification       text NOT NULL CHECK (length(justification) BETWEEN 1 AND 2000),
  required_by_date    date,
  currency            char(3) NOT NULL,
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'cancelled')),
  approval_instance_id uuid,
  submitted_at        timestamptz,
  decided_at          timestamptz,
  cancel_reason       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, request_number),
  FOREIGN KEY (organization_id, requester_user_id) REFERENCES users(organization_id, id),
  FOREIGN KEY (organization_id, department_id) REFERENCES departments(organization_id, id),
  FOREIGN KEY (organization_id, team_id) REFERENCES teams(organization_id, id),
  CHECK (status <> 'draft' OR submitted_at IS NULL),
  CHECK (status NOT IN ('approved', 'rejected') OR decided_at IS NOT NULL),
  CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL)
);
CREATE INDEX idx_requests_status ON purchase_requests(organization_id, status);
CREATE INDEX idx_requests_requester ON purchase_requests(organization_id, requester_user_id);

CREATE TABLE purchase_request_items (
  id                      uuid PRIMARY KEY,
  organization_id         uuid NOT NULL REFERENCES organizations(id),
  request_id              uuid NOT NULL,
  line_no                 integer NOT NULL CHECK (line_no >= 1),
  description             text NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
  category_id             uuid,
  model_id                uuid,
  quantity                bigint NOT NULL CHECK (quantity >= 1),
  estimated_unit_cost_minor bigint NOT NULL CHECK (estimated_unit_cost_minor >= 0),
  line_total_minor        bigint NOT NULL CHECK (line_total_minor >= 0),
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (request_id, line_no),
  FOREIGN KEY (organization_id, request_id) REFERENCES purchase_requests(organization_id, id),
  FOREIGN KEY (organization_id, category_id) REFERENCES asset_categories(organization_id, id),
  FOREIGN KEY (organization_id, model_id) REFERENCES asset_models(organization_id, id)
);
CREATE INDEX idx_request_items_request ON purchase_request_items(organization_id, request_id);

-- Draft line items are replaced wholesale on each edit (DELETE + re-INSERT within one
-- transaction); once submitted, a request's items become immutable (enforced in the service —
-- a controlled amendment is a new draft revision via resubmission, not an in-place edit).

-- ---------------------------------------------------------------- configurable approvals

CREATE TABLE approval_policies (
  id                      uuid PRIMARY KEY,
  organization_id         uuid NOT NULL REFERENCES organizations(id),
  policy_group_id         uuid NOT NULL,
  version                 integer NOT NULL CHECK (version >= 1),
  transaction_type        text NOT NULL CHECK (transaction_type IN ('purchase_request')),
  name                    text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  min_amount_minor        bigint CHECK (min_amount_minor IS NULL OR min_amount_minor >= 0),
  currency                char(3),
  prevent_self_approval   boolean NOT NULL DEFAULT true,
  is_active               boolean NOT NULL DEFAULT true,
  is_current              boolean NOT NULL DEFAULT true,
  created_by              uuid NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (policy_group_id, version),
  FOREIGN KEY (organization_id, created_by) REFERENCES users(organization_id, id),
  CHECK (min_amount_minor IS NULL OR currency IS NOT NULL)
);
-- Exactly one current version per configured policy slot; older versions stay readable so
-- approval instances that snapshotted them remain fully explainable.
CREATE UNIQUE INDEX one_current_version_per_policy ON approval_policies(policy_group_id) WHERE is_current;
CREATE INDEX idx_policies_type ON approval_policies(organization_id, transaction_type) WHERE is_current AND is_active;

CREATE TABLE approval_policy_steps (
  id                  uuid PRIMARY KEY,
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  policy_id           uuid NOT NULL,
  step_order          integer NOT NULL CHECK (step_order >= 1),
  required_role_key   text,
  required_user_id    uuid,
  UNIQUE (organization_id, id),
  UNIQUE (policy_id, step_order),
  FOREIGN KEY (organization_id, policy_id) REFERENCES approval_policies(organization_id, id),
  FOREIGN KEY (organization_id, required_role_key) REFERENCES roles(organization_id, key),
  FOREIGN KEY (organization_id, required_user_id) REFERENCES users(organization_id, id),
  CHECK (num_nonnulls(required_role_key, required_user_id) = 1)
);
CREATE INDEX idx_policy_steps_policy ON approval_policy_steps(organization_id, policy_id, step_order);

CREATE TABLE approval_instances (
  id                  uuid PRIMARY KEY,
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  entity_type         text NOT NULL CHECK (entity_type IN ('purchase_request')),
  entity_id           uuid NOT NULL,
  policy_id           uuid NOT NULL,
  requester_user_id   uuid NOT NULL,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  current_step        integer NOT NULL DEFAULT 1 CHECK (current_step >= 1),
  total_steps         integer NOT NULL CHECK (total_steps >= 1),
  created_at          timestamptz NOT NULL DEFAULT now(),
  decided_at          timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, policy_id) REFERENCES approval_policies(organization_id, id),
  FOREIGN KEY (organization_id, requester_user_id) REFERENCES users(organization_id, id),
  CHECK ((status = 'pending') = (decided_at IS NULL))
);
-- One active approval chain per request at a time; a rejected request that is resubmitted gets a
-- brand-new instance (full history of every past attempt is preserved, never overwritten).
CREATE UNIQUE INDEX one_pending_instance_per_entity ON approval_instances(entity_type, entity_id) WHERE status = 'pending';
CREATE INDEX idx_instances_entity ON approval_instances(organization_id, entity_type, entity_id);

CREATE TABLE approval_decisions (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  instance_id     uuid NOT NULL,
  step_order      integer NOT NULL CHECK (step_order >= 1),
  decided_by      uuid NOT NULL,
  decision        text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason          text,
  decided_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (instance_id, step_order),
  FOREIGN KEY (organization_id, instance_id) REFERENCES approval_instances(organization_id, id),
  FOREIGN KEY (organization_id, decided_by) REFERENCES users(organization_id, id)
);
CREATE FUNCTION approval_decisions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'approval decisions are append-only'; END $$;
CREATE TRIGGER approval_decisions_no_change BEFORE UPDATE OR DELETE ON approval_decisions FOR EACH ROW EXECUTE FUNCTION approval_decisions_append_only();
CREATE TRIGGER approval_decisions_no_truncate BEFORE TRUNCATE ON approval_decisions FOR EACH STATEMENT EXECUTE FUNCTION approval_decisions_append_only();

-- ---------------------------------------------------------------- purchase orders

CREATE TABLE purchase_orders (
  id                      uuid PRIMARY KEY,
  organization_id         uuid NOT NULL REFERENCES organizations(id),
  po_number               text NOT NULL,
  supplier_id             uuid NOT NULL,
  request_id              uuid NOT NULL,
  currency                char(3) NOT NULL,
  status                  text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partially_received', 'received', 'cancelled')),
  order_date              date,
  expected_delivery_date  date,
  notes                   text,
  cancel_reason           text,
  created_by              uuid NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, po_number),
  FOREIGN KEY (organization_id, supplier_id) REFERENCES suppliers(organization_id, id),
  FOREIGN KEY (organization_id, request_id) REFERENCES purchase_requests(organization_id, id),
  FOREIGN KEY (organization_id, created_by) REFERENCES users(organization_id, id),
  CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL)
);
CREATE INDEX idx_orders_status ON purchase_orders(organization_id, status);
CREATE INDEX idx_orders_request ON purchase_orders(organization_id, request_id);

CREATE TABLE purchase_order_items (
  id                  uuid PRIMARY KEY,
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  po_id               uuid NOT NULL,
  request_item_id     uuid,
  line_no             integer NOT NULL CHECK (line_no >= 1),
  description         text NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
  category_id         uuid NOT NULL,
  model_id            uuid,
  quantity            bigint NOT NULL CHECK (quantity >= 1),
  unit_price_minor    bigint NOT NULL CHECK (unit_price_minor >= 0),
  line_total_minor    bigint NOT NULL CHECK (line_total_minor >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (po_id, line_no),
  FOREIGN KEY (organization_id, po_id) REFERENCES purchase_orders(organization_id, id),
  FOREIGN KEY (organization_id, request_item_id) REFERENCES purchase_request_items(organization_id, id),
  FOREIGN KEY (organization_id, category_id) REFERENCES asset_categories(organization_id, id),
  FOREIGN KEY (organization_id, model_id) REFERENCES asset_models(organization_id, id)
);
CREATE INDEX idx_order_items_po ON purchase_order_items(organization_id, po_id);

CREATE TABLE purchase_order_amendments (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  po_id           uuid NOT NULL,
  po_item_id      uuid,
  field           text NOT NULL,
  old_value       text,
  new_value       text,
  reason          text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  amended_by      uuid NOT NULL,
  amended_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, po_id) REFERENCES purchase_orders(organization_id, id),
  FOREIGN KEY (organization_id, po_item_id) REFERENCES purchase_order_items(organization_id, id),
  FOREIGN KEY (organization_id, amended_by) REFERENCES users(organization_id, id)
);
CREATE INDEX idx_amendments_po ON purchase_order_amendments(organization_id, po_id, amended_at);
CREATE FUNCTION po_amendments_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'purchase order amendments are append-only'; END $$;
CREATE TRIGGER po_amendments_no_change BEFORE UPDATE OR DELETE ON purchase_order_amendments FOR EACH ROW EXECUTE FUNCTION po_amendments_append_only();
CREATE TRIGGER po_amendments_no_truncate BEFORE TRUNCATE ON purchase_order_amendments FOR EACH STATEMENT EXECUTE FUNCTION po_amendments_append_only();

-- ---------------------------------------------------------------- goods receipt

CREATE TABLE goods_receipts (
  id                  uuid PRIMARY KEY,
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  receipt_number      text NOT NULL,
  po_id               uuid NOT NULL,
  received_by         uuid NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  supplier_reference  text,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, receipt_number),
  FOREIGN KEY (organization_id, po_id) REFERENCES purchase_orders(organization_id, id),
  FOREIGN KEY (organization_id, received_by) REFERENCES users(organization_id, id)
);
CREATE INDEX idx_receipts_po ON goods_receipts(organization_id, po_id);

CREATE TABLE goods_receipt_items (
  id                  uuid PRIMARY KEY,
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  receipt_id          uuid NOT NULL,
  po_item_id          uuid NOT NULL,
  received_quantity   bigint NOT NULL CHECK (received_quantity >= 1),
  accepted_quantity   bigint NOT NULL DEFAULT 0 CHECK (accepted_quantity >= 0),
  damaged_quantity    bigint NOT NULL DEFAULT 0 CHECK (damaged_quantity >= 0),
  rejected_quantity   bigint NOT NULL DEFAULT 0 CHECK (rejected_quantity >= 0),
  discrepancy_status  text NOT NULL DEFAULT 'none' CHECK (discrepancy_status IN ('none', 'open', 'resolved')),
  discrepancy_notes   text,
  resolution_notes    text,
  resolved_by         uuid,
  resolved_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, receipt_id) REFERENCES goods_receipts(organization_id, id),
  FOREIGN KEY (organization_id, po_item_id) REFERENCES purchase_order_items(organization_id, id),
  FOREIGN KEY (organization_id, resolved_by) REFERENCES users(organization_id, id),
  CHECK (received_quantity = accepted_quantity + damaged_quantity + rejected_quantity),
  CHECK (discrepancy_status <> 'resolved' OR resolved_at IS NOT NULL)
);
CREATE INDEX idx_receipt_items_receipt ON goods_receipt_items(organization_id, receipt_id);
CREATE INDEX idx_receipt_items_po_item ON goods_receipt_items(organization_id, po_item_id);

-- One row per physical unit for an individually-tracked line; absent entirely for bulk lines.
CREATE TABLE goods_receipt_units (
  id                  uuid PRIMARY KEY,
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  receipt_item_id     uuid NOT NULL,
  unit_no             integer NOT NULL CHECK (unit_no >= 1),
  serial_number       text,
  disposition         text NOT NULL CHECK (disposition IN ('accepted', 'damaged', 'rejected')),
  asset_id            uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (receipt_item_id, unit_no),
  FOREIGN KEY (organization_id, receipt_item_id) REFERENCES goods_receipt_items(organization_id, id),
  FOREIGN KEY (organization_id, asset_id) REFERENCES assets(organization_id, id)
);
-- Idempotency guard: retrying asset registration for the same unit can never create a second asset.
CREATE UNIQUE INDEX one_asset_per_receipt_unit ON goods_receipt_units(organization_id, asset_id) WHERE asset_id IS NOT NULL;

-- ---------------------------------------------------------------- bulk stock

CREATE TABLE stock_movements (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  category_id     uuid NOT NULL,
  location_id     uuid NOT NULL,
  movement_type   text NOT NULL CHECK (movement_type IN ('received')),
  quantity        bigint NOT NULL CHECK (quantity <> 0),
  receipt_item_id uuid,
  reason          text,
  actor_user_id   uuid NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, category_id) REFERENCES asset_categories(organization_id, id),
  FOREIGN KEY (organization_id, location_id) REFERENCES locations(organization_id, id),
  FOREIGN KEY (organization_id, receipt_item_id) REFERENCES goods_receipt_items(organization_id, id),
  FOREIGN KEY (organization_id, actor_user_id) REFERENCES users(organization_id, id)
);
-- Idempotency guard: retrying a bulk receipt line can never post the stock movement twice.
CREATE UNIQUE INDEX one_movement_per_receipt_item ON stock_movements(organization_id, receipt_item_id) WHERE receipt_item_id IS NOT NULL;
CREATE INDEX idx_movements_category ON stock_movements(organization_id, category_id, location_id);
CREATE FUNCTION stock_movements_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'stock movements are append-only'; END $$;
CREATE TRIGGER stock_movements_no_change BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION stock_movements_append_only();
CREATE TRIGGER stock_movements_no_truncate BEFORE TRUNCATE ON stock_movements FOR EACH STATEMENT EXECUTE FUNCTION stock_movements_append_only();

CREATE TABLE bulk_stock_balances (
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  category_id       uuid NOT NULL,
  location_id       uuid NOT NULL,
  quantity_on_hand  bigint NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, category_id, location_id),
  FOREIGN KEY (organization_id, category_id) REFERENCES asset_categories(organization_id, id),
  FOREIGN KEY (organization_id, location_id) REFERENCES locations(organization_id, id)
);

-- Purchase requests, orders, and receipts can own supporting documents (quotations, invoices,
-- delivery notes, inspection photos).
ALTER TABLE document_links DROP CONSTRAINT document_links_entity_type_check;
ALTER TABLE document_links ADD CONSTRAINT document_links_entity_type_check CHECK (entity_type IN ('asset', 'handover', 'clearance_item', 'maintenance_ticket', 'audit_item', 'purchase_request', 'purchase_order', 'goods_receipt'));
`
}
