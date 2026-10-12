/**
 * Platform tables: idempotency keys for retry-safe mutations (D36) and CSV import sessions
 * (moved from process memory to the database so any app instance can continue an import).
 */
export const migration0002 = {
  version: 2,
  name: 'platform',
  sql: `
CREATE TABLE idempotency_keys (
  organization_id uuid NOT NULL,
  user_id         uuid NOT NULL,
  key             uuid NOT NULL,
  command         text NOT NULL,
  request_hash    char(64) NOT NULL,
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (organization_id, user_id, key),
  FOREIGN KEY (organization_id, user_id) REFERENCES users(organization_id, id)
);
CREATE INDEX idx_idempotency_expires ON idempotency_keys(expires_at);

CREATE TABLE import_sessions (
  id              char(32) PRIMARY KEY,
  organization_id uuid NOT NULL,
  user_id         uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('employees')),
  file_name       text NOT NULL,
  file_bytes      integer NOT NULL CHECK (file_bytes >= 0),
  file_sha256     char(64) NOT NULL,
  parsed          jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  FOREIGN KEY (organization_id, user_id) REFERENCES users(organization_id, id)
);
CREATE INDEX idx_import_sessions_owner ON import_sessions(organization_id, user_id);
`
} as const
