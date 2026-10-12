import { createHash, randomBytes } from 'node:crypto'
import type { ImportCounts, ImportPreview, ImportResult } from '@shared/api'
import { IMPORT_FIELDS, type ImportDateFormat } from '@shared/organization'
import { importCommitInputSchema, importPreviewInputSchema, type ImportCommitInput, type ImportMapping, type ImportPreviewInput } from '@shared/orgSchemas'
import { AppError, assertPermission, newId, type OpContext } from '../core'
import type { Db, SqlClient } from '../db/sql'
import { normalizeKey } from '../services/common'
import { normalizeEmployeeCode } from '../services/employees'
import { auditFrom, getSettings, recordAudit } from '../services/foundation'
import { decodeCsv, parseCsv, type ParsedCsv } from './csv'
import { autoMapHeaders, loadImportLookups, validateEmployeeImport } from './employeeValidation'

const SESSION_TTL_MINUTES = 30

interface SessionRow {
  id: string
  fileName: string
  fileBytes: number
  fileSha256: string
  parsed: ParsedCsv
}

async function buildPreview(c: SqlClient, ctx: OpContext, s: SessionRow, mapping: ImportMapping, dateFormat: ImportDateFormat): Promise<ImportPreview> {
  const v = validateEmployeeImport(s.parsed, mapping, dateFormat, await loadImportLookups(c, ctx.actor.organizationId))
  return {
    importId: s.id,
    fileName: s.fileName,
    fileBytes: s.fileBytes,
    headers: s.parsed.headers,
    mapping,
    dateFormat,
    fileIssues: v.fileIssues,
    rows: v.rows,
    counts: v.counts,
    duplicateEmailPolicy: (await getSettings(c, ctx.actor.organizationId)).employeeDuplicateEmailPolicy
  }
}

/** Stores an uploaded CSV as an import session (owner-bound, expiring). Never writes employees. */
export async function startEmployeeImport(db: Db, file: { fileName: string; data: Uint8Array }, ctx: OpContext): Promise<ImportPreview> {
  assertPermission(ctx.actor.permissions, 'employees.import')
  const parsed = parseCsv(decodeCsv(file.data))
  const session: SessionRow = {
    id: randomBytes(16).toString('hex'),
    fileName: file.fileName.replace(/[\u0000-\u001f]/g, '').slice(-255) || 'import.csv',
    fileBytes: file.data.byteLength,
    fileSha256: createHash('sha256').update(file.data).digest('hex'),
    parsed
  }
  await db.exec('DELETE FROM import_sessions WHERE expires_at < now()')
  await db.exec(
    `INSERT INTO import_sessions (id, organization_id, user_id, kind, file_name, file_bytes, file_sha256, parsed, expires_at)
     VALUES ($1, $2, $3, 'employees', $4, $5, $6, $7, now() + make_interval(mins => $8))`,
    [session.id, ctx.actor.organizationId, ctx.actor.userId, session.fileName, session.fileBytes, session.fileSha256, JSON.stringify(parsed), SESSION_TTL_MINUTES]
  )
  return buildPreview(db, ctx, session, autoMapHeaders(parsed.headers), 'YYYY-MM-DD')
}

async function loadSession(c: SqlClient, ctx: OpContext, importId: string, forUpdate: boolean): Promise<SessionRow> {
  const s = await c.one<SessionRow>(
    `SELECT id, file_name AS "fileName", file_bytes AS "fileBytes", file_sha256 AS "fileSha256", parsed
     FROM import_sessions WHERE id = $1 AND organization_id = $2 AND user_id = $3 AND consumed_at IS NULL AND expires_at > now()${forUpdate ? ' FOR UPDATE' : ''}`,
    [importId, ctx.actor.organizationId, ctx.actor.userId]
  )
  if (!s) throw new AppError('NOT_FOUND', 'This import is no longer available (it expired, was cancelled or already imported). Upload the file again.')
  return s
}

export async function previewEmployeeImport(db: Db, raw: ImportPreviewInput, ctx: OpContext): Promise<ImportPreview> {
  assertPermission(ctx.actor.permissions, 'employees.import')
  const input = importPreviewInputSchema.parse(raw)
  return buildPreview(db, ctx, await loadSession(db, ctx, input.importId, false), input.mapping, input.dateFormat)
}

/**
 * Re-validates against current data inside one transaction (session row locked) and inserts all
 * importable rows; any error rolls back every row and leaves the session reusable.
 */
export async function commitEmployeeImport(db: Db, raw: ImportCommitInput, ctx: OpContext): Promise<ImportResult> {
  assertPermission(ctx.actor.permissions, 'employees.import')
  const input = importCommitInputSchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    const session = await loadSession(t, ctx, input.importId, true)
    const v = validateEmployeeImport(session.parsed, input.mapping, input.dateFormat, await loadImportLookups(t, org))
    const counts: ImportCounts = v.counts
    if (v.fileIssues.length) throw new AppError('VALIDATION_ERROR', v.fileIssues.join(' '))
    const blocked = counts.rejected + counts.duplicates
    if (blocked > 0 && !input.skipInvalidRows) {
      throw new AppError('VALIDATION_ERROR', `${blocked} row(s) are rejected or duplicates. Correct the file and upload it again, or choose to skip those rows.`)
    }
    if (v.importable.length === 0) throw new AppError('VALIDATION_ERROR', 'There are no valid rows to import.')

    const idByRow = new Map<number, string>()
    for (const r of v.importable) {
      const id = newId()
      idByRow.set(r.rowNumber, id)
      await t.exec(
        `INSERT INTO employees (id, organization_id, employee_code, employee_code_normalized, full_name, email, email_normalized, phone, job_title,
                                department_id, team_id, work_location_id, employment_status, joining_date, expected_exit_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [id, org, r.employeeCode, normalizeEmployeeCode(r.employeeCode), r.fullName, r.email, r.email ? normalizeKey(r.email) : null, r.phone, r.jobTitle,
          r.departmentId, r.teamId, r.workLocationId, r.employmentStatus, r.joiningDate, r.expectedExitDate]
      )
    }
    // Managers are linked after all rows exist so rows may reference each other in any order.
    for (const r of v.importable) {
      const managerId = r.managerExistingId ?? (r.managerRowNumber !== null ? (idByRow.get(r.managerRowNumber) ?? null) : null)
      if (managerId) await t.exec('UPDATE employees SET manager_employee_id = $2 WHERE id = $1', [idByRow.get(r.rowNumber)!, managerId])
    }
    await t.exec('UPDATE import_sessions SET consumed_at = now() WHERE id = $1', [session.id])
    // Summary only: counts, file fingerprint and mapped fields; no names or contact details.
    await recordAudit(t, {
      ...auditFrom(ctx),
      eventType: 'employees.imported',
      entityType: 'employee_import',
      entityId: session.id,
      summary: {
        fileName: session.fileName,
        fileSha256: session.fileSha256,
        fileBytes: session.fileBytes,
        ...counts,
        imported: v.importable.length,
        skipInvalidRows: input.skipInvalidRows,
        dateFormat: input.dateFormat,
        mappedFields: IMPORT_FIELDS.filter((f) => input.mapping[f] !== null)
      }
    })
    return { imported: v.importable.length, skipped: counts.rejected + counts.duplicates, counts }
  })
}

export async function cancelEmployeeImport(db: Db, importId: string, ctx: OpContext): Promise<void> {
  assertPermission(ctx.actor.permissions, 'employees.import')
  await db.exec('UPDATE import_sessions SET consumed_at = now() WHERE id = $1 AND organization_id = $2 AND user_id = $3 AND consumed_at IS NULL', [importId, ctx.actor.organizationId, ctx.actor.userId])
}
