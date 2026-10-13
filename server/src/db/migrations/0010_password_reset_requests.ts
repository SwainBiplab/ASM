/**
 * Self-service "forgot password" request queue (U2): an unauthenticated user can ask to be
 * noticed by an administrator without learning whether their username matched a real account.
 * The actual reset still happens through the existing admin-reset path (`users.resetPassword`,
 * which now also auto-resolves any pending request for that user in the same transaction);
 * this table only tracks who asked and whether it has been handled.
 */
export const migration0010 = {
  version: 10,
  name: 'password_reset_requests',
  sql: `
CREATE TABLE password_reset_requests (
  id                  uuid PRIMARY KEY,
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  user_id             uuid NOT NULL REFERENCES users(id),
  message             text,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed')),
  requested_at        timestamptz NOT NULL DEFAULT now(),
  requested_ip        text,
  resolved_at         timestamptz,
  resolved_by_user_id uuid REFERENCES users(id),
  CHECK ((status = 'pending') = (resolved_at IS NULL))
);
CREATE INDEX idx_password_reset_requests_org_status ON password_reset_requests(organization_id, status, requested_at DESC);
-- At most one pending request per user: repeated clicks don't flood the admin queue.
CREATE UNIQUE INDEX uq_password_reset_requests_one_pending ON password_reset_requests(user_id) WHERE status = 'pending';
`
} as const
