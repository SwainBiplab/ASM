import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { ASSET_SORTS, CONDITIONS, DOCUMENT_PURPOSES, LIFECYCLE_STATUSES, MAX_DOCUMENT_BYTES, OPERATIONAL_STATUSES, WARRANTY_FILTERS } from '@shared/assets'
import { IMPORT_MAX_BYTES } from '@shared/organization'
import { AppError, type Actor, type Logger, type OpContext } from '../core'
import type { Db } from '../db/sql'
import { toCsv } from '../exports/csv'
import { startEmployeeImport } from '../imports/employeeImport'
import { startAssetImport } from '../imports/assetImport'
import { failure, requestHash, toFailure, withIdempotency, type DispatchOutcome } from '../rpc/dispatcher'
import { importPreviewOutput, documentLinkOutput, assetImportUploadOutput } from '../rpc/responsesW2'
import { exportAssetRows } from '../services/assets'
import { exportAssetValuationRows, exportDisposalRows, exportMaintenanceCostRows, exportProcurementDiscrepancyRows, exportWarrantyRows } from '../services/reports'
import { WEB_DOCUMENT_OWNER_TYPES, attachDocument, readDocument } from '../services/documents'
import { auditFrom, recordAudit } from '../services/foundation'
import type { DocumentStorage } from '../storage/storage'

export interface FileRouteDeps {
  db: Db
  storage: DocumentStorage
  logger: Logger
  authenticate: (req: FastifyRequest) => Promise<Actor | null>
  csrfRejected: (req: FastifyRequest) => string | null
}

/** Route schemas for non-RPC routes (D34/D35): every query and path parameter is validated. */
const uuid = z.string().uuid()
const documentUploadQuery = z.strictObject({ entityType: z.enum(WEB_DOCUMENT_OWNER_TYPES), entityId: uuid, purpose: z.enum(DOCUMENT_PURPOSES) })
const assetImportUploadQuery = z.strictObject({ sheet: z.string().trim().min(1).max(200).optional() })
const documentParams = z.strictObject({ documentId: uuid })
const assetExportQuery = z.strictObject({
  query: z.string().trim().max(200).optional(),
  categoryId: uuid.optional(),
  lifecycle: z.enum([...LIFECYCLE_STATUSES, 'all']).optional(),
  operational: z.enum(OPERATIONAL_STATUSES).optional(),
  condition: z.enum(CONDITIONS).optional(),
  locationId: uuid.optional(),
  supplierId: uuid.optional(),
  warranty: z.enum(WARRANTY_FILTERS).optional(),
  sort: z.enum(ASSET_SORTS).optional(),
  direction: z.enum(['asc', 'desc']).optional()
})

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const valuationExportQuery = z.strictObject({
  categoryId: uuid.optional(), locationId: uuid.optional(), departmentId: uuid.optional(), supplierId: uuid.optional(),
  lifecycle: z.enum([...LIFECYCLE_STATUSES, 'all']).optional(), fromDate: dateStr.optional(), toDate: dateStr.optional(),
  onlyMissingFinancialMetadata: z.coerce.boolean().optional()
})
const maintenanceCostExportQuery = z.strictObject({
  assetId: uuid.optional(), categoryId: uuid.optional(), locationId: uuid.optional(), vendorQuery: z.string().trim().max(160).optional(),
  fromDate: dateStr.optional(), toDate: dateStr.optional()
})
const warrantyExportQuery = z.strictObject({ filter: z.enum(['expiring', 'expired', 'missing']).optional(), windowDays: z.coerce.number().int().min(1).max(730).optional() })
const disposalExportQuery = z.strictObject({ fromDate: dateStr.optional(), toDate: dateStr.optional() })

const send = (reply: FastifyReply, o: DispatchOutcome) => reply.header('cache-control', 'no-store').status(o.status).send(o.body)

/** RFC 6266 filename with a safe ASCII fallback. */
function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_')
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

export function registerFileRoutes(app: FastifyInstance, deps: FileRouteDeps): void {
  async function guard(req: FastifyRequest, reply: FastifyReply, opts: { csrf: boolean }): Promise<OpContext | null> {
    const correlationId = String(req.id)
    if (opts.csrf) {
      const rejected = deps.csrfRejected(req)
      if (rejected) {
        void send(reply, failure('FORBIDDEN_SENDER', rejected, correlationId))
        return null
      }
    }
    const actor = await deps.authenticate(req)
    if (!actor) {
      void send(reply, failure('NOT_AUTHENTICATED', 'Please sign in.', correlationId))
      return null
    }
    return { correlationId, actor, ip: req.ip ?? null }
  }

  /** Reads exactly one multipart file with a hard size limit (enforced while streaming). */
  async function readSingleFile(req: FastifyRequest, maxBytes: number): Promise<{ fileName: string; data: Buffer; mime: string | null }> {
    if (!req.isMultipart()) throw new AppError('VALIDATION_ERROR', 'Send the file as multipart/form-data.')
    const part = await req.file({ limits: { fileSize: maxBytes, files: 1, fields: 0 } })
    if (!part) throw new AppError('VALIDATION_ERROR', 'No file was uploaded.')
    const data = await part.toBuffer()
    if (part.file.truncated) throw new AppError('VALIDATION_ERROR', `The file is larger than ${Math.floor(maxBytes / (1024 * 1024))} MB.`)
    return { fileName: part.filename, data, mime: part.mimetype || null }
  }

  // ---- document upload: idempotency required (a retried upload must not attach twice)
  app.post('/api/v1/uploads/documents', async (req, reply) => {
    const ctx = await guard(req, reply, { csrf: true })
    if (!ctx) return reply
    try {
      const query = documentUploadQuery.parse(req.query)
      const key = req.headers['idempotency-key']
      if (typeof key !== 'string') throw new AppError('VALIDATION_ERROR', 'This request needs an Idempotency-Key header so retries cannot run it twice.')
      const file = await readSingleFile(req, MAX_DOCUMENT_BYTES)
      const hash = requestHash('documents.upload', { query, fileName: file.fileName, sha256: createHash('sha256').update(file.data).digest('hex') })
      const outcome = await withIdempotency({ db: deps.db, actor: ctx.actor, key, command: 'documents.upload', hash }, ctx.correlationId, async (db) => {
        try {
          const link = await attachDocument(db, deps.storage, { fileName: file.fileName, data: file.data, declaredMime: file.mime }, query, ctx)
          return { status: 200, body: { ok: true, data: documentLinkOutput.parse(link) } }
        } catch (err) {
          return toFailure(err, ctx.correlationId, deps.logger, 'documents.upload')
        }
      })
      return send(reply, outcome)
    } catch (err) {
      return send(reply, toFailure(err, ctx.correlationId, deps.logger, 'documents.upload'))
    }
  })

  // ---- employee CSV import: stores an import session and returns the preview (no employee writes)
  app.post('/api/v1/uploads/employee-import', async (req, reply) => {
    const ctx = await guard(req, reply, { csrf: true })
    if (!ctx) return reply
    try {
      if (!ctx.actor.permissions.has('employees.import')) throw new AppError('PERMISSION_DENIED', 'You do not have permission to perform this action.')
      const file = await readSingleFile(req, IMPORT_MAX_BYTES)
      const preview = await startEmployeeImport(deps.db, { fileName: file.fileName, data: file.data }, ctx)
      return send(reply, { status: 200, body: { ok: true, data: importPreviewOutput.parse(preview) } })
    } catch (err) {
      return send(reply, toFailure(err, ctx.correlationId, deps.logger, 'employees.importUpload'))
    }
  })

  // ---- asset CSV/Excel import: stores an import session and returns the preview (no asset writes).
  // An optional `?sheet=` chooses one sheet of a multi-sheet workbook; omitted, a multi-sheet file
  // returns a sheet-choice response instead, and the caller re-uploads the same file with `sheet` set.
  app.post('/api/v1/uploads/asset-import', async (req, reply) => {
    const ctx = await guard(req, reply, { csrf: true })
    if (!ctx) return reply
    try {
      if (!ctx.actor.permissions.has('assets.import')) throw new AppError('PERMISSION_DENIED', 'You do not have permission to perform this action.')
      const query = assetImportUploadQuery.parse(req.query)
      const file = await readSingleFile(req, IMPORT_MAX_BYTES)
      const preview = await startAssetImport(deps.db, { fileName: file.fileName, data: file.data }, query.sheet ?? null, ctx)
      return send(reply, { status: 200, body: { ok: true, data: assetImportUploadOutput.parse(preview) } })
    } catch (err) {
      return send(reply, toFailure(err, ctx.correlationId, deps.logger, 'assets.importUpload'))
    }
  })

  // ---- authorized, checksum-verified document download (audited)
  app.get('/api/v1/documents/:documentId/content', async (req, reply) => {
    const ctx = await guard(req, reply, { csrf: false })
    if (!ctx) return reply
    try {
      const { documentId } = documentParams.parse(req.params)
      const doc = await readDocument(deps.db, deps.storage, documentId, ctx)
      return reply
        .header('content-type', doc.mimeType)
        .header('content-disposition', contentDisposition(doc.inline ? 'inline' : 'attachment', doc.originalName))
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .send(doc.data)
    } catch (err) {
      return send(reply, toFailure(err, ctx.correlationId, deps.logger, 'documents.download'))
    }
  })

  // ---- asset register export (same filters as assets.search; cost columns only with finance permission)
  app.get('/api/v1/exports/assets.csv', async (req, reply) => {
    const ctx = await guard(req, reply, { csrf: false })
    if (!ctx) return reply
    try {
      const filters = assetExportQuery.parse(req.query)
      const data = await exportAssetRows(deps.db, filters, ctx)
      await recordAudit(deps.db, { ...auditFrom(ctx), eventType: 'assets.exported', entityType: 'asset_export', summary: { rowCount: data.rows.length, includesCost: data.includesCost, filters } })
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', contentDisposition('attachment', `assets-${new Date().toISOString().slice(0, 10)}.csv`))
        .header('cache-control', 'no-store')
        .send(toCsv(data.headers, data.rows))
    } catch (err) {
      return send(reply, toFailure(err, ctx.correlationId, deps.logger, 'assets.export'))
    }
  })

  // ---- W7 financial/management report exports (same filters, authorization and calculation as the on-screen report)
  app.get('/api/v1/exports/reports/asset-valuation.csv', async (req, reply) => {
    const ctx = await guard(req, reply, { csrf: false })
    if (!ctx) return reply
    try {
      const filters = valuationExportQuery.parse(req.query)
      const data = await exportAssetValuationRows(deps.db, filters, ctx)
      await recordAudit(deps.db, { ...auditFrom(ctx), eventType: 'reports.exported', entityType: 'report_export', summary: { report: 'assetValuation', rowCount: data.rows.length, includesCost: data.includesCost, filters } })
      return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', contentDisposition('attachment', `asset-valuation-${new Date().toISOString().slice(0, 10)}.csv`)).header('cache-control', 'no-store').send(toCsv(data.headers, data.rows))
    } catch (err) {
      return send(reply, toFailure(err, ctx.correlationId, deps.logger, 'reports.assetValuation.export'))
    }
  })

  app.get('/api/v1/exports/reports/maintenance-cost.csv', async (req, reply) => {
    const ctx = await guard(req, reply, { csrf: false })
    if (!ctx) return reply
    try {
      const filters = maintenanceCostExportQuery.parse(req.query)
      const data = await exportMaintenanceCostRows(deps.db, filters, ctx)
      await recordAudit(deps.db, { ...auditFrom(ctx), eventType: 'reports.exported', entityType: 'report_export', summary: { report: 'maintenanceCost', rowCount: data.rows.length, includesCost: data.includesCost, filters } })
      return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', contentDisposition('attachment', `maintenance-cost-${new Date().toISOString().slice(0, 10)}.csv`)).header('cache-control', 'no-store').send(toCsv(data.headers, data.rows))
    } catch (err) {
      return send(reply, toFailure(err, ctx.correlationId, deps.logger, 'reports.maintenanceCost.export'))
    }
  })

  app.get('/api/v1/exports/reports/warranty.csv', async (req, reply) => {
    const ctx = await guard(req, reply, { csrf: false })
    if (!ctx) return reply
    try {
      const filters = warrantyExportQuery.parse(req.query)
      const data = await exportWarrantyRows(deps.db, filters, ctx)
      await recordAudit(deps.db, { ...auditFrom(ctx), eventType: 'reports.exported', entityType: 'report_export', summary: { report: 'warranty', rowCount: data.rows.length, filters } })
      return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', contentDisposition('attachment', `warranty-${new Date().toISOString().slice(0, 10)}.csv`)).header('cache-control', 'no-store').send(toCsv(data.headers, data.rows))
    } catch (err) {
      return send(reply, toFailure(err, ctx.correlationId, deps.logger, 'reports.warranty.export'))
    }
  })

  app.get('/api/v1/exports/reports/disposals.csv', async (req, reply) => {
    const ctx = await guard(req, reply, { csrf: false })
    if (!ctx) return reply
    try {
      const filters = disposalExportQuery.parse(req.query)
      const data = await exportDisposalRows(deps.db, filters, ctx)
      await recordAudit(deps.db, { ...auditFrom(ctx), eventType: 'reports.exported', entityType: 'report_export', summary: { report: 'disposals', rowCount: data.rows.length, includesCost: data.includesCost, filters } })
      return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', contentDisposition('attachment', `disposals-${new Date().toISOString().slice(0, 10)}.csv`)).header('cache-control', 'no-store').send(toCsv(data.headers, data.rows))
    } catch (err) {
      return send(reply, toFailure(err, ctx.correlationId, deps.logger, 'reports.disposals.export'))
    }
  })

  app.get('/api/v1/exports/reports/procurement-discrepancies.csv', async (req, reply) => {
    const ctx = await guard(req, reply, { csrf: false })
    if (!ctx) return reply
    try {
      const data = await exportProcurementDiscrepancyRows(deps.db, ctx)
      await recordAudit(deps.db, { ...auditFrom(ctx), eventType: 'reports.exported', entityType: 'report_export', summary: { report: 'procurementDiscrepancies', rowCount: data.rows.length } })
      return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', contentDisposition('attachment', `procurement-discrepancies-${new Date().toISOString().slice(0, 10)}.csv`)).header('cache-control', 'no-store').send(toCsv(data.headers, data.rows))
    } catch (err) {
      return send(reply, toFailure(err, ctx.correlationId, deps.logger, 'reports.procurementDiscrepancies.export'))
    }
  })
}
