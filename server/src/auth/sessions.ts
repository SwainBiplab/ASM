import { createHash, randomBytes } from 'node:crypto'
import type { Db, SqlClient } from '../db/sql'

/**
 * Server-side sessions (DECISIONS D28). The cookie holds a random 256-bit token; only its
 * SHA-256 is stored, so a database leak does not expose usable session tokens.
 */
export const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex')

export interface NewSession {
  token: string
  idHash: string
  absoluteExpiresAt: Date
}

export async function createSession(
  c: SqlClient,
  s: { organizationId: string; userId: string; absoluteHours: number; ip: string | null; userAgent: string | null }
): Promise<NewSession> {
  const token = randomBytes(32).toString('base64url')
  const idHash = hashToken(token)
  const absoluteExpiresAt = new Date(Date.now() + s.absoluteHours * 3_600_000)
  await c.exec(
    `INSERT INTO sessions (id_hash, organization_id, user_id, absolute_expires_at, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5, $6)`,
    [idHash, s.organizationId, s.userId, absoluteExpiresAt.toISOString(), s.ip, s.userAgent?.slice(0, 200) ?? null]
  )
  return { token, idHash, absoluteExpiresAt }
}

export interface ResolvedSession {
  idHash: string
  userId: string
  organizationId: string
}

/** Activity updates are throttled to keep request overhead low. */
const TOUCH_INTERVAL_SECONDS = 60

/**
 * Validates a session token: not revoked, within absolute and idle limits, user still active.
 * Expired sessions are revoked on the spot. Returns null when the caller is not signed in.
 */
export async function resolveSession(db: Db, token: string | undefined, idleMinutes: (orgId: string) => Promise<number>): Promise<ResolvedSession | null> {
  if (!token || token.length > 100) return null
  const idHash = hashToken(token)
  const row = await db.one<{
    userId: string
    organizationId: string
    revoked: boolean
    absoluteExpired: boolean
    idleSeconds: number
    active: boolean
  }>(
    `SELECT s.user_id AS "userId", s.organization_id AS "organizationId", s.revoked_at IS NOT NULL AS revoked,
            s.absolute_expires_at <= now() AS "absoluteExpired", extract(epoch FROM now() - s.last_seen_at)::int AS "idleSeconds",
            u.is_active AS active
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = $1`,
    [idHash]
  )
  if (!row || row.revoked) return null
  const idleLimit = (await idleMinutes(row.organizationId)) * 60
  const reason = !row.active ? 'user_deactivated' : row.absoluteExpired ? 'absolute_timeout' : row.idleSeconds > idleLimit ? 'idle_timeout' : null
  if (reason) {
    await revokeSession(db, idHash, reason)
    return null
  }
  if (row.idleSeconds >= TOUCH_INTERVAL_SECONDS) await db.exec('UPDATE sessions SET last_seen_at = now() WHERE id_hash = $1', [idHash])
  return { idHash, userId: row.userId, organizationId: row.organizationId }
}

export async function touchSession(c: SqlClient, idHash: string): Promise<void> {
  await c.exec('UPDATE sessions SET last_seen_at = now() WHERE id_hash = $1 AND revoked_at IS NULL', [idHash])
}

export async function revokeSession(c: SqlClient, idHash: string, reason: string): Promise<void> {
  await c.exec('UPDATE sessions SET revoked_at = now(), revoke_reason = $2 WHERE id_hash = $1 AND revoked_at IS NULL', [idHash, reason])
}

/** Ends all of a user's sessions (optionally keeping the current one), e.g. after a password change. */
export async function revokeUserSessions(c: SqlClient, userId: string, reason: string, exceptIdHash?: string): Promise<number> {
  return c.exec(
    'UPDATE sessions SET revoked_at = now(), revoke_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL AND id_hash <> $3',
    [userId, reason, exceptIdHash ?? '']
  )
}
