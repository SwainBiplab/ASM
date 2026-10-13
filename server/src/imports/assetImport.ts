import { createHash, randomBytes } from 'node:crypto'
import type { AssetImportPreview, AssetImportSheetChoice, ImportCounts, ImportResult } from '@shared/api'
import type { ImportDateFormat } from '@shared/organization'
import { assetImportCommitInputSchema, assetImportPreviewInputSchema, type AssetImportCommitInput, type AssetImportMapping, type AssetImportPreviewInput } from '@shared/assetSchemas'
import { ASSET_IMPORT_FIELDS } from '@shared/assets'
import { AppError, assertPermission, newId, type OpContext } from '../core'
import type { Db, SqlClient } from '../db/sql'
import { baseCurrency, issueAssetCode, parseCost } from '../services/assets'
import { auditFrom, recordAudit } from '../services/foundation'
import { decodeCsv, parseCsv, type ParsedCsv } from './csv'
import { isExcelFile, readExcelWorkbook } from './excel'
import { autoMapAssetHeaders, loadAssetImportLookups, validateAssetImport } from './assetValidation'

const SESSION_TTL_MINUTES = 30

interface SessionRow {
  id: string
  fileName: string
  fileBytes: number
  fileSha256: string
  parsed: ParsedCsv
}

const canViewCost = (ctx: OpContext): boolean => ctx.actor.permissions.has('finance.view_cost')

async function buildPreview(c: SqlClient, ctx: OpContext, s: SessionRow, mapping: AssetImportMapping, dateFormat: ImportDateFormat): Promise<AssetImportPreview> {
  const lk = await loadAssetImportLookups(c, ctx.actor.organizationId, canViewCost(ctx), await baseCurrency(c, ctx))
  const v = validateAssetImport(s.parsed, mapping, dateFormat, lk)
  return {
    importId: s.id,
    fileName: s.fileName,
    fileBytes: s.fileBytes,
    headers: s.parsed.headers,
    mapping,
    dateFormat,
    fileIssues: v.fileIssues,
    rows: v.rows,
    counts: v.counts
  }
}

/** Decodes the upload into a flat table, or a sheet-choice response for a multi-sheet workbook. */
async function readTable(data: Buffer, sheet: string | null): Promise<ParsedCsv | AssetImportSheetChoice> {
  if (!isExcelFile(data)) return parseCsv(decodeCsv(data))
  const result = await readExcelWorkbook(data, sheet)
  return result.kind === 'choose' ? { needsSheetSelection: true, sheets: result.sheets } : result.table
}

/**
 * Stores an uploaded CSV or Excel sheet as an import session (owner-bound, expiring). Never writes
 * assets. A multi-sheet workbook with no `sheet` chosen yet returns a sheet-choice response instead
 * of a session; the caller re-uploads the same file with a sheet name to continue.
 */
export async function startAssetImport(
  db: Db,
  file: { fileName: string; data: Buffer },
  sheet: string | null,
  ctx: OpContext
): Promise<AssetImportPreview | AssetImportSheetChoice> {
  assertPermission(ctx.actor.permissions, 'assets.import')
  const parsed = await readTable(file.data, sheet)
  if ('needsSheetSelection' in parsed) return parsed

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
     VALUES ($1, $2, $3, 'assets', $4, $5, $6, $7, now() + make_interval(mins => $8))`,
    [session.id, ctx.actor.organizationId, ctx.actor.userId, session.fileName, session.fileBytes, session.fileSha256, JSON.stringify(parsed), SESSION_TTL_MINUTES]
  )
  return buildPreview(db, ctx, session, autoMapAssetHeaders(parsed.headers), 'YYYY-MM-DD')
}

async function loadSession(c: SqlClient, ctx: OpContext, importId: string, forUpdate: boolean): Promise<SessionRow> {
  const s = await c.one<SessionRow>(
    `SELECT id, file_name AS "fileName", file_bytes AS "fileBytes", file_sha256 AS "fileSha256", parsed
     FROM import_sessions WHERE id = $1 AND organization_id = $2 AND user_id = $3 AND kind = 'assets' AND consumed_at IS NULL AND expires_at > now()${forUpdate ? ' FOR UPDATE' : ''}`,
    [importId, ctx.actor.organizationId, ctx.actor.userId]
  )
  if (!s) throw new AppError('NOT_FOUND', 'This import is no longer available (it expired, was cancelled or already imported). Upload the file again.')
  return s
}

export async function previewAssetImport(db: Db, raw: AssetImportPreviewInput, ctx: OpContext): Promise<AssetImportPreview> {
  assertPermission(ctx.actor.permissions, 'assets.import')
  const input = assetImportPreviewInputSchema.parse(raw)
  return buildPreview(db, ctx, await loadSession(db, ctx, input.importId, false), input.mapping, input.dateFormat)
}

/**
 * Re-validates against current data inside one transaction (session row locked) and inserts all
 * importable rows; any error rolls back every row and leaves the session reusable. Each row's
 * asset code is issued the same way `assets.create` issues one -- never supplied by the file.
 */
export async function commitAssetImport(db: Db, raw: AssetImportCommitInput, ctx: OpContext): Promise<ImportResult> {
  assertPermission(ctx.actor.permissions, 'assets.import')
  const input = assetImportCommitInputSchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    const session = await loadSession(t, ctx, input.importId, true)
    const lk = await loadAssetImportLookups(t, org, canViewCost(ctx), await baseCurrency(t, ctx))
    const v = validateAssetImport(session.parsed, input.mapping, input.dateFormat, lk)
    const counts: ImportCounts = v.counts
    if (v.fileIssues.length) throw new AppError('VALIDATION_ERROR', v.fileIssues.join(' '))
    if (counts.rejected > 0 && !input.skipInvalidRows) {
      throw new AppError('VALIDATION_ERROR', `${counts.rejected} row(s) are rejected. Correct the file and upload it again, or choose to skip those rows.`)
    }
    if (v.importable.length === 0) throw new AppError('VALIDATION_ERROR', 'There are no valid rows to import.')

    const currency = await baseCurrency(t, ctx)
    let imported = 0
    for (const r of v.importable) {
      const id = newId()
      const code = await issueAssetCode(t, org)
      const cost = await parseCost(t, ctx, r.acquisitionCost, 'acquisitionCost')
      await t.exec(
        `INSERT INTO assets (id, organization_id, asset_code, category_id, model_id, manufacturer, model_name, serial_number, serial_normalized, serial_unique_key,
                             operational_status, condition, location_id, supplier_id, purchase_date, acquisition_cost_minor, currency,
                             invoice_reference, purchase_reference, warranty_start, warranty_end, notes)
         VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, 'ready', $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
        [id, org, code, r.categoryId, r.manufacturer, r.modelName, r.serialNumber, r.serialNormalized, r.serialUniqueKey,
          r.condition, r.locationId, r.supplierId, r.purchaseDate, cost, currency, r.invoiceReference, r.purchaseReference, r.warrantyStart, r.warrantyEnd, r.notes]
      )
      imported++
    }
    await t.exec('UPDATE import_sessions SET consumed_at = now() WHERE id = $1', [session.id])
    // Cost values stay out of the audit summary, same as a single `assets.create` (finance.view_cost).
    await recordAudit(t, {
      ...auditFrom(ctx),
      eventType: 'assets.imported',
      entityType: 'asset_import',
      entityId: session.id,
      summary: {
        fileName: session.fileName,
        fileSha256: session.fileSha256,
        fileBytes: session.fileBytes,
        ...counts,
        imported,
        skipInvalidRows: input.skipInvalidRows,
        dateFormat: input.dateFormat,
        mappedFields: ASSET_IMPORT_FIELDS.filter((f) => input.mapping[f] !== null)
      }
    })
    return { imported, skipped: counts.rejected, counts }
  })
}

export async function cancelAssetImport(db: Db, importId: string, ctx: OpContext): Promise<void> {
  assertPermission(ctx.actor.permissions, 'assets.import')
  await db.exec("UPDATE import_sessions SET consumed_at = now() WHERE id = $1 AND organization_id = $2 AND user_id = $3 AND kind = 'assets' AND consumed_at IS NULL", [
    importId, ctx.actor.organizationId, ctx.actor.userId
  ])
}
