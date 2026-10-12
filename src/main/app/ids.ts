import { randomBytes, randomUUID } from 'node:crypto'

export const newId = (): string => randomUUID()

/** Short correlation ID shown to users and written to logs. */
export const newCorrelationId = (): string => randomBytes(6).toString('hex')

/** UTC ISO-8601 timestamp (TAS §4.3). */
export const nowIso = (): string => new Date().toISOString()
