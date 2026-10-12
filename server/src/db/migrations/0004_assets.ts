/**
 * Asset catalogue, register and documents (port of prototype M3 to PostgreSQL).
 * Assignment state is not stored on assets; it is derived from assignments (W4).
 * Depreciation columns are intentionally absent until Finance approves a policy (TAS F1).
 */
export const migration0004 = {
  version: 4,
  name: 'assets',
  sql: `
CREATE TABLE asset_categories (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  code            text NOT NULL,
  code_normalized text NOT NULL,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  name_normalized text NOT NULL,
  description     text,
  asset_domain    text NOT NULL CHECK (asset_domain IN ('it', 'facilities')),
  tracking_mode   text NOT NULL DEFAULT 'individual' CHECK (tracking_mode IN ('individual', 'bulk')),
  serial_required boolean NOT NULL DEFAULT false,
  serial_unique   boolean NOT NULL DEFAULT false,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, code_normalized),
  UNIQUE (organization_id, name_normalized),
  CHECK (NOT serial_unique OR serial_required)
);

CREATE TABLE asset_models (
  id                      uuid PRIMARY KEY,
  organization_id         uuid NOT NULL REFERENCES organizations(id),
  category_id             uuid NOT NULL,
  manufacturer            text NOT NULL CHECK (length(manufacturer) BETWEEN 1 AND 120),
  manufacturer_normalized text NOT NULL,
  model_name              text NOT NULL CHECK (length(model_name) BETWEEN 1 AND 120),
  model_name_normalized   text NOT NULL,
  model_number            text,
  specifications          text,
  is_active               boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (category_id, manufacturer_normalized, model_name_normalized),
  FOREIGN KEY (organization_id, category_id) REFERENCES asset_categories(organization_id, id)
);

CREATE TABLE suppliers (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  code            text,
  code_normalized text,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  name_normalized text NOT NULL,
  contact_name    text,
  email           text,
  phone           text,
  address         text,
  tax_reference   text,
  notes           text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, name_normalized)
);
CREATE UNIQUE INDEX ux_suppliers_code ON suppliers(organization_id, code_normalized) WHERE code_normalized IS NOT NULL;

-- One counter row per organization (TAS B1, D20). Locked FOR UPDATE when a code is issued;
-- next_number only increases, so codes are never reused.
CREATE TABLE asset_code_config (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  prefix          text NOT NULL CHECK (prefix ~ '^[A-Z][A-Z0-9]{0,9}$'),
  separator       text NOT NULL CHECK (separator IN ('-', '/', '')),
  padding         integer NOT NULL CHECK (padding BETWEEN 3 AND 10),
  next_number     bigint NOT NULL CHECK (next_number >= 1),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES users(id)
);
INSERT INTO asset_code_config (organization_id, prefix, separator, padding, next_number)
SELECT id, 'AST', '-', 6, 1 FROM organizations;

CREATE TABLE assets (
  id                      uuid PRIMARY KEY,
  organization_id         uuid NOT NULL REFERENCES organizations(id),
  asset_code              text NOT NULL,
  category_id             uuid NOT NULL,
  model_id                uuid,
  manufacturer            text,
  model_name              text,
  serial_number           text,
  serial_normalized       text,
  serial_unique_key       text,
  specifications          text,
  lifecycle_status        text NOT NULL DEFAULT 'active' CHECK (lifecycle_status IN ('active', 'retired', 'disposed', 'lost')),
  operational_status      text NOT NULL DEFAULT 'ready' CHECK (operational_status IN ('ready', 'under_maintenance', 'non_operational', 'awaiting_inspection')),
  condition               text NOT NULL DEFAULT 'new' CHECK (condition IN ('new', 'good', 'fair', 'damaged', 'unknown')),
  location_id             uuid,
  supplier_id             uuid,
  purchase_date           date,
  acquisition_cost_minor  bigint CHECK (acquisition_cost_minor IS NULL OR acquisition_cost_minor >= 0),
  currency                char(3),
  invoice_reference       text,
  purchase_reference      text,
  warranty_start          date,
  warranty_end            date,
  disposal_date           date,
  disposal_method         text CHECK (disposal_method IS NULL OR disposal_method IN ('sold', 'scrapped', 'donated', 'returned_to_vendor', 'written_off', 'other')),
  disposal_proceeds_minor bigint CHECK (disposal_proceeds_minor IS NULL OR disposal_proceeds_minor >= 0),
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, asset_code),
  FOREIGN KEY (organization_id, category_id) REFERENCES asset_categories(organization_id, id),
  FOREIGN KEY (organization_id, model_id) REFERENCES asset_models(organization_id, id),
  FOREIGN KEY (organization_id, location_id) REFERENCES locations(organization_id, id),
  FOREIGN KEY (organization_id, supplier_id) REFERENCES suppliers(organization_id, id),
  CHECK (warranty_start IS NULL OR warranty_end IS NULL OR warranty_end >= warranty_start),
  CHECK (lifecycle_status <> 'disposed' OR disposal_date IS NOT NULL),
  CHECK (lifecycle_status = 'active' OR operational_status <> 'under_maintenance')
);
-- Serial uniqueness per category policy, enforced by the database (key maintained by the service).
CREATE UNIQUE INDEX ux_assets_serial_unique ON assets(organization_id, serial_unique_key) WHERE serial_unique_key IS NOT NULL;
CREATE INDEX idx_assets_category ON assets(category_id);
CREATE INDEX idx_assets_model ON assets(model_id);
CREATE INDEX idx_assets_status ON assets(organization_id, lifecycle_status, operational_status);
CREATE INDEX idx_assets_location ON assets(location_id);
CREATE INDEX idx_assets_supplier ON assets(supplier_id);
CREATE INDEX idx_assets_serial ON assets(organization_id, serial_normalized) WHERE serial_normalized IS NOT NULL;
CREATE INDEX idx_assets_warranty ON assets(organization_id, warranty_end) WHERE warranty_end IS NOT NULL;

CREATE FUNCTION assets_code_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.asset_code IS DISTINCT FROM OLD.asset_code OR NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'asset identity (id, organization, asset_code) is immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER assets_identity_immutable BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION assets_code_immutable();
CREATE FUNCTION assets_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'assets cannot be deleted; dispose them instead' USING ERRCODE = 'P0001'; END;
$$;
CREATE TRIGGER assets_no_delete BEFORE DELETE ON assets FOR EACH ROW EXECUTE FUNCTION assets_no_delete();

-- Document metadata; bytes live in DocumentStorage under a generated key (D35).
CREATE TABLE documents (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  storage_key     text NOT NULL UNIQUE,
  original_name   text NOT NULL CHECK (length(original_name) BETWEEN 1 AND 255),
  mime_type       text NOT NULL,
  byte_size       bigint NOT NULL CHECK (byte_size > 0),
  sha256          char(64) NOT NULL,
  scan_status     text NOT NULL CHECK (scan_status IN ('not_scanned', 'pending', 'clean', 'rejected', 'quarantined')),
  uploaded_by     uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);

-- Polymorphic owner validated by the service (TAS 7.1); soft-removed, never deleted.
CREATE TABLE document_links (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  document_id     uuid NOT NULL,
  entity_type     text NOT NULL CHECK (entity_type IN ('asset')),
  entity_id       uuid NOT NULL,
  purpose         text NOT NULL CHECK (purpose IN ('invoice', 'warranty', 'purchase_order', 'handover', 'photo', 'repair_evidence', 'audit_evidence', 'disposal', 'other')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  removed_at      timestamptz,
  removed_by      uuid REFERENCES users(id),
  removal_reason  text,
  FOREIGN KEY (organization_id, document_id) REFERENCES documents(organization_id, id),
  CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
CREATE INDEX idx_document_links_owner ON document_links(organization_id, entity_type, entity_id);
CREATE INDEX idx_document_links_document ON document_links(document_id);
`
} as const
