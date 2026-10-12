/**
 * Asset catalogue, register and documents (M3).
 *
 * RECONSTRUCTED (prompt29, 2026-10-12): the original file was missing from the git history —
 * the repository's entire prior history had been replaced by a single squashed commit that
 * never included it (confirmed: `git log --all`/`git show origin/development --stat` show no
 * commit, anywhere, containing this path). No backup existed in the working tree or VS Code
 * local history either. This content is derived, not guessed, from two independent sources
 * that must already agree with the original migration's intent: (1) every SQL statement
 * `src/main/services/{assets,catalog,documents}.ts` issues against these tables (columns,
 * nullability, enum values) and (2) `server/src/db/migrations/0004_assets.ts`, whose own header
 * states it is "a port of prototype M3 to PostgreSQL" — i.e. an already-reviewed, already-tested
 * translation of this exact migration's schema. Two columns present only in that later Postgres
 * port and never read or written by the frozen prototype code (`documents.scan_status`,
 * `document_links.removal_reason` — both added for the cloud app's W7 malware-scanning work)
 * are intentionally left out here, since nothing in `src/main` evidences they were part of M3.
 * Reviewed, not blindly trusted: if evidence and intent ever conflict, flag it rather than guess.
 */
export const migration0003 = {
  version: 3,
  name: 'assets',
  sql: `
CREATE TABLE asset_categories (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization_profile(id),
  code            TEXT,
  code_normalized TEXT,
  name            TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  name_normalized TEXT NOT NULL,
  description     TEXT,
  asset_domain    TEXT NOT NULL CHECK (asset_domain IN ('it', 'facilities')),
  tracking_mode   TEXT NOT NULL DEFAULT 'individual' CHECK (tracking_mode IN ('individual', 'bulk')),
  serial_required INTEGER NOT NULL DEFAULT 0 CHECK (serial_required IN (0, 1)),
  serial_unique   INTEGER NOT NULL DEFAULT 0 CHECK (serial_unique IN (0, 1)),
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK (serial_unique = 0 OR serial_required = 1)
) STRICT;
CREATE UNIQUE INDEX ux_asset_categories_code ON asset_categories(organization_id, code_normalized) WHERE code_normalized IS NOT NULL;
CREATE UNIQUE INDEX ux_asset_categories_name ON asset_categories(organization_id, name_normalized);

CREATE TABLE asset_models (
  id                      TEXT PRIMARY KEY,
  organization_id         TEXT NOT NULL REFERENCES organization_profile(id),
  category_id             TEXT NOT NULL REFERENCES asset_categories(id),
  manufacturer            TEXT NOT NULL CHECK (length(manufacturer) BETWEEN 1 AND 120),
  manufacturer_normalized TEXT NOT NULL,
  model_name              TEXT NOT NULL CHECK (length(model_name) BETWEEN 1 AND 120),
  model_name_normalized   TEXT NOT NULL,
  model_number            TEXT,
  specifications          TEXT,
  is_active               INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX ux_asset_models_identity ON asset_models(category_id, manufacturer_normalized, model_name_normalized);
CREATE INDEX idx_asset_models_category ON asset_models(category_id);

CREATE TABLE suppliers (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization_profile(id),
  code            TEXT,
  code_normalized TEXT,
  name            TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  name_normalized TEXT NOT NULL,
  contact_name    TEXT,
  email           TEXT,
  phone           TEXT,
  address         TEXT,
  tax_reference   TEXT,
  notes           TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX ux_suppliers_name ON suppliers(organization_id, name_normalized);
CREATE UNIQUE INDEX ux_suppliers_code ON suppliers(organization_id, code_normalized) WHERE code_normalized IS NOT NULL;

-- Single-organization counter (TAS B1, D20: default AST-000001). next_number only increases,
-- so a code is never reused; asset_code itself is immutable once issued (trigger below).
CREATE TABLE asset_code_config (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  prefix      TEXT NOT NULL CHECK (length(prefix) BETWEEN 1 AND 10),
  separator   TEXT NOT NULL CHECK (separator IN ('-', '/', '')),
  padding     INTEGER NOT NULL CHECK (padding BETWEEN 3 AND 10),
  next_number INTEGER NOT NULL CHECK (next_number >= 1),
  updated_at  TEXT NOT NULL,
  updated_by  TEXT REFERENCES users(id)
) STRICT;
INSERT INTO asset_code_config (id, prefix, separator, padding, next_number, updated_at) VALUES (1, 'AST', '-', 6, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE assets (
  id                      TEXT PRIMARY KEY,
  organization_id         TEXT NOT NULL REFERENCES organization_profile(id),
  asset_code              TEXT NOT NULL UNIQUE,
  category_id             TEXT NOT NULL REFERENCES asset_categories(id),
  model_id                TEXT REFERENCES asset_models(id),
  manufacturer            TEXT,
  model_name              TEXT,
  serial_number           TEXT,
  serial_normalized       TEXT,
  serial_unique_key       TEXT,
  specifications          TEXT,
  lifecycle_status        TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_status IN ('active', 'retired', 'disposed', 'lost')),
  operational_status      TEXT NOT NULL DEFAULT 'ready' CHECK (operational_status IN ('ready', 'under_maintenance', 'non_operational', 'awaiting_inspection')),
  condition               TEXT NOT NULL DEFAULT 'new' CHECK (condition IN ('new', 'good', 'fair', 'damaged', 'unknown')),
  location_id             TEXT REFERENCES locations(id),
  supplier_id             TEXT REFERENCES suppliers(id),
  purchase_date           TEXT,
  acquisition_cost_minor  INTEGER CHECK (acquisition_cost_minor IS NULL OR acquisition_cost_minor >= 0),
  currency                TEXT,
  invoice_reference       TEXT,
  purchase_reference      TEXT,
  warranty_start          TEXT,
  warranty_end            TEXT,
  disposal_date           TEXT,
  disposal_method         TEXT,
  disposal_proceeds_minor INTEGER CHECK (disposal_proceeds_minor IS NULL OR disposal_proceeds_minor >= 0),
  notes                   TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  CHECK (warranty_start IS NULL OR warranty_end IS NULL OR warranty_end >= warranty_start),
  CHECK (lifecycle_status <> 'disposed' OR disposal_date IS NOT NULL),
  CHECK (lifecycle_status = 'active' OR operational_status <> 'under_maintenance')
) STRICT;
-- Serial uniqueness per category policy; the key itself is maintained by the service (catalog.ts).
CREATE UNIQUE INDEX ux_assets_serial_unique ON assets(serial_unique_key) WHERE serial_unique_key IS NOT NULL;
CREATE INDEX idx_assets_category ON assets(category_id);
CREATE INDEX idx_assets_model ON assets(model_id);
CREATE INDEX idx_assets_status ON assets(lifecycle_status, operational_status);
CREATE INDEX idx_assets_location ON assets(location_id);
CREATE INDEX idx_assets_supplier ON assets(supplier_id);
CREATE INDEX idx_assets_serial ON assets(serial_normalized) WHERE serial_normalized IS NOT NULL;
CREATE INDEX idx_assets_warranty ON assets(warranty_end) WHERE warranty_end IS NOT NULL;

-- Asset identity is immutable once issued (CLAUDE.md: "asset_code is immutable (DB trigger)").
CREATE TRIGGER assets_identity_immutable BEFORE UPDATE ON assets
WHEN NEW.asset_code <> OLD.asset_code OR NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id
BEGIN SELECT RAISE(ABORT, 'asset identity (id, organization, asset_code) is immutable'); END;

CREATE TRIGGER assets_no_delete BEFORE DELETE ON assets
BEGIN SELECT RAISE(ABORT, 'assets cannot be deleted; dispose them instead'); END;

-- Document metadata; bytes live on disk under documentsRoot (set by the container).
CREATE TABLE documents (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization_profile(id),
  storage_key     TEXT NOT NULL UNIQUE,
  original_name   TEXT NOT NULL CHECK (length(original_name) BETWEEN 1 AND 255),
  mime_type       TEXT NOT NULL,
  byte_size       INTEGER NOT NULL CHECK (byte_size > 0),
  sha256          TEXT NOT NULL CHECK (length(sha256) = 64),
  uploaded_by     TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL
) STRICT;

-- Polymorphic owner validated by the service, not a foreign key; soft-removed, never deleted.
CREATE TABLE document_links (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('asset')),
  entity_id   TEXT NOT NULL,
  purpose     TEXT NOT NULL CHECK (purpose IN ('invoice', 'warranty', 'purchase_order', 'handover', 'photo', 'repair_evidence', 'audit_evidence', 'disposal', 'other')),
  created_at  TEXT NOT NULL,
  created_by  TEXT REFERENCES users(id),
  removed_at  TEXT,
  removed_by  TEXT REFERENCES users(id),
  CHECK ((removed_at IS NULL) = (removed_by IS NULL))
) STRICT;
CREATE INDEX idx_document_links_owner ON document_links(entity_type, entity_id);
CREATE INDEX idx_document_links_document ON document_links(document_id);
`
} as const
