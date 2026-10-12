/**
 * PostgreSQL foundation: organizations, identity/RBAC, sessions, settings, audit trail.
 * Every root table carries organization_id (single organization deployed; boundary enforced
 * by the server). Never edit an applied migration; add a new one.
 */
export const migration0001 = {
  version: 1,
  name: 'foundation',
  sql: `
CREATE TABLE organizations (
  id            uuid PRIMARY KEY,
  legal_name    text NOT NULL CHECK (length(legal_name) BETWEEN 1 AND 200),
  display_name  text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  base_currency char(3) NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
  timezone      text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                   uuid PRIMARY KEY,
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  username             text NOT NULL,
  username_normalized  text NOT NULL,
  display_name         text NOT NULL,
  password_hash        text NOT NULL,
  is_active            boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT false,
  failed_login_count   integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until         timestamptz,
  last_login_at        timestamptz,
  password_changed_at  timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, username_normalized),
  UNIQUE (organization_id, id)
);

CREATE TABLE roles (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  key             text NOT NULL,
  name            text NOT NULL,
  description     text NOT NULL DEFAULT '',
  is_system       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key),
  UNIQUE (organization_id, id)
);

CREATE TABLE permissions (
  key         text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE role_permissions (
  role_id        uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key),
  granted_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_key)
);

-- Composite FKs keep a user's roles inside the user's own organization.
CREATE TABLE user_roles (
  organization_id uuid NOT NULL,
  user_id         uuid NOT NULL,
  role_id         uuid NOT NULL,
  assigned_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id),
  FOREIGN KEY (organization_id, user_id) REFERENCES users(organization_id, id),
  FOREIGN KEY (organization_id, role_id) REFERENCES roles(organization_id, id)
);
CREATE INDEX idx_user_roles_role ON user_roles(role_id);

-- Only a SHA-256 of the session token is stored; the token itself lives in the cookie.
CREATE TABLE sessions (
  id_hash             char(64) PRIMARY KEY,
  organization_id     uuid NOT NULL,
  user_id             uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  revoked_at          timestamptz,
  revoke_reason       text,
  ip_address          text,
  user_agent          text,
  FOREIGN KEY (organization_id, user_id) REFERENCES users(organization_id, id),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX idx_sessions_user_active ON sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE app_settings (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  key             text NOT NULL,
  value           jsonb NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES users(id),
  PRIMARY KEY (organization_id, key)
);

CREATE TABLE audit_events (
  id              uuid PRIMARY KEY,
  organization_id uuid REFERENCES organizations(id),
  occurred_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  seq             bigint GENERATED ALWAYS AS IDENTITY,
  actor_user_id   uuid REFERENCES users(id),
  event_type      text NOT NULL,
  entity_type     text NOT NULL,
  entity_id       text,
  reason          text,
  correlation_id  text NOT NULL,
  ip_address      text,
  summary         jsonb
);
CREATE INDEX idx_audit_events_org_time ON audit_events(organization_id, occurred_at DESC, seq DESC);
CREATE INDEX idx_audit_events_entity ON audit_events(organization_id, entity_type, entity_id);
CREATE INDEX idx_audit_events_type ON audit_events(organization_id, event_type);

CREATE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'P0001';
END;
$$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();
`
} as const
