/**
 * Foundation schema: organization, identity/RBAC, settings, audit trail, backup history.
 * Never edit an applied migration — add a new one. The runner verifies checksums.
 */
export const migration0001 = {
  version: 1,
  name: 'foundation',
  sql: `
CREATE TABLE organization_profile (
  id            TEXT PRIMARY KEY,
  singleton     INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1),
  legal_name    TEXT NOT NULL CHECK (length(legal_name) BETWEEN 1 AND 200),
  display_name  TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  base_currency TEXT NOT NULL CHECK (length(base_currency) = 3),
  timezone      TEXT NOT NULL,
  address_json  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
) STRICT;

CREATE TABLE users (
  id                   TEXT PRIMARY KEY,
  organization_id      TEXT NOT NULL REFERENCES organization_profile(id),
  username             TEXT NOT NULL,
  username_normalized  TEXT NOT NULL UNIQUE,
  display_name         TEXT NOT NULL,
  password_hash        TEXT NOT NULL,
  is_active            INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  failed_login_count   INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until         TEXT,
  last_login_at        TEXT,
  password_changed_at  TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
) STRICT;

CREATE TABLE roles (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization_profile(id),
  key             TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  is_system       INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
) STRICT;

CREATE TABLE permissions (
  key         TEXT PRIMARY KEY,
  description TEXT NOT NULL
) STRICT;

CREATE TABLE role_permissions (
  role_id        TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL REFERENCES permissions(key),
  granted_at     TEXT NOT NULL,
  PRIMARY KEY (role_id, permission_key)
) STRICT, WITHOUT ROWID;

CREATE TABLE user_roles (
  user_id     TEXT NOT NULL REFERENCES users(id),
  role_id     TEXT NOT NULL REFERENCES roles(id),
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (user_id, role_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_user_roles_role ON user_roles(role_id);

CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id)
) STRICT;

CREATE TABLE audit_events (
  id             TEXT PRIMARY KEY,
  occurred_at    TEXT NOT NULL,
  actor_user_id  TEXT REFERENCES users(id),
  event_type     TEXT NOT NULL,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT,
  reason         TEXT,
  correlation_id TEXT NOT NULL,
  summary_json   TEXT
) STRICT;

CREATE INDEX idx_audit_events_occurred ON audit_events(occurred_at);
CREATE INDEX idx_audit_events_entity ON audit_events(entity_type, entity_id);
CREATE INDEX idx_audit_events_type ON audit_events(event_type);

-- Audit history is append-only (TAS §8.8): reject edits and deletes at the database level.
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;

CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;

CREATE TABLE backup_history (
  id             TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('manual', 'automatic', 'pre_migration', 'pre_restore')),
  relative_path  TEXT NOT NULL,
  checksum       TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  app_version    TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('verified', 'failed')),
  error_message  TEXT,
  actor_user_id  TEXT REFERENCES users(id),
  database_bytes INTEGER NOT NULL CHECK (database_bytes >= 0),
  document_count INTEGER NOT NULL CHECK (document_count >= 0)
) STRICT;
`
} as const
