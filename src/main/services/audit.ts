import type { Database as DB } from 'better-sqlite3'
import type { AuditEventView, Page } from '@shared/api'
import { auditListInputSchema, type AuditListInput } from '@shared/schemas'
import { newId, nowIso } from '../app/ids'
import { redact } from '../logging/logger'

export interface AuditEntry {
  actorUserId: string | null
  eventType: string
  entityType: string
  entityId?: string | null
  reason?: string | null
  correlationId: string
  summary?: Record<string, unknown>
}

/** Appends an audit event. Call inside the same transaction as the business change. */
export function recordAudit(db: DB, entry: AuditEntry): string {
  const id = newId()
  db.prepare(
    `INSERT INTO audit_events (id, occurred_at, actor_user_id, event_type, entity_type, entity_id, reason, correlation_id, summary_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    nowIso(),
    entry.actorUserId,
    entry.eventType,
    entry.entityType,
    entry.entityId ?? null,
    entry.reason ?? null,
    entry.correlationId,
    entry.summary ? JSON.stringify(redact(entry.summary)) : null
  )
  return id
}

interface AuditRow {
  id: string
  occurredAt: string
  actorUserId: string | null
  actorName: string | null
  eventType: string
  entityType: string
  entityId: string | null
  reason: string | null
  correlationId: string
  summaryJson: string | null
}

export function listAuditEvents(db: DB, rawInput: AuditListInput): Page<AuditEventView> {
  const input = auditListInputSchema.parse(rawInput)
  const where: string[] = []
  const params: unknown[] = []
  if (input.eventType) {
    where.push('a.event_type = ?')
    params.push(input.eventType)
  }
  if (input.entityType) {
    where.push('a.entity_type = ?')
    params.push(input.entityType)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = (db.prepare(`SELECT count(*) AS n FROM audit_events a ${whereSql}`).get(...params) as { n: number }).n
  const rows = db
    .prepare(
      `SELECT a.id, a.occurred_at AS occurredAt, a.actor_user_id AS actorUserId, u.display_name AS actorName,
              a.event_type AS eventType, a.entity_type AS entityType, a.entity_id AS entityId, a.reason,
              a.correlation_id AS correlationId, a.summary_json AS summaryJson
       FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
       ${whereSql}
       ORDER BY a.occurred_at DESC, a.rowid DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, input.pageSize, (input.page - 1) * input.pageSize) as AuditRow[]
  return {
    items: rows.map(({ summaryJson, ...r }) => ({
      ...r,
      summary: summaryJson ? (JSON.parse(summaryJson) as Record<string, unknown>) : null
    })),
    total,
    page: input.page,
    pageSize: input.pageSize
  }
}
