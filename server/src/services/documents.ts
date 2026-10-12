import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import type { DocumentLinkView } from '@shared/api'
import { ALLOWED_DOCUMENT_TYPES, MAX_DOCUMENT_BYTES, type DocumentPurpose } from '@shared/assets'
import { attachDocumentSchema, removeDocumentLinkSchema, type AttachDocumentInput, type RemoveDocumentLinkInput } from '@shared/assetSchemas'
import type { PermissionKey } from '@shared/permissions'
import { z } from 'zod'
import { AppError, assertAnyPermission, newId, type OpContext } from '../core'
import { recordSignedReceipt } from './allocations'
import type { Db, SqlClient } from '../db/sql'
import type { DocumentStorage } from '../storage/storage'
import { auditFrom, recordAudit } from './foundation'

/**
 * Owner types allowed for web documents, with the permissions (any of) needed to view or attach (D35).
 * Handovers hold signed receipts; clearance items hold loss/damage evidence (W4). Maintenance
 * tickets hold repair evidence; audit items hold discrepancy evidence (W5).
 */
export const WEB_DOCUMENT_OWNER_TYPES = ['asset', 'handover', 'clearance_item', 'maintenance_ticket', 'audit_item', 'purchase_request', 'purchase_order', 'goods_receipt'] as const
export type OwnerType = (typeof WEB_DOCUMENT_OWNER_TYPES)[number]
const OWNER_RULES: Record<OwnerType, { table: string; view: readonly PermissionKey[]; manage: readonly PermissionKey[] }> = {
  asset: { table: 'assets', view: ['assets.view'], manage: ['assets.update'] },
  handover: { table: 'handovers', view: ['allocations.view'], manage: ['allocations.issue', 'allocations.transfer', 'allocations.return'] },
  clearance_item: { table: 'exit_clearance_items', view: ['exit_clearance.view'], manage: ['exit_clearance.manage'] },
  maintenance_ticket: { table: 'maintenance_tickets', view: ['maintenance.view'], manage: ['maintenance.create', 'maintenance.update', 'maintenance.close'] },
  audit_item: { table: 'audit_items', view: ['audits.view'], manage: ['audits.verify', 'audits.manage', 'audits.resolve'] },
  purchase_request: { table: 'purchase_requests', view: ['procurement.view'], manage: ['procurement.create', 'procurement.submit'] },
  purchase_order: { table: 'purchase_orders', view: ['procurement.view'], manage: ['procurement.manage_orders'] },
  goods_receipt: { table: 'goods_receipts', view: ['procurement.view'], manage: ['receipts.record'] }
}
const webAttachSchema = attachDocumentSchema.extend({ entityType: z.enum(WEB_DOCUMENT_OWNER_TYPES) })
export type WebAttachInput = z.infer<typeof webAttachSchema>

/** Magic-byte checks so a renamed executable cannot pose as a PDF or image (prototype D22). */
const SIGNATURES: Record<string, (b: Uint8Array) => boolean> = {
  pdf: (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46,
  png: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  docx: (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04,
  xlsx: (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04,
  txt: (b) => !b.includes(0),
  csv: (b) => !b.includes(0)
}
/** Types that may be shown inline in the browser; everything else downloads as an attachment. */
const INLINE_TYPES = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp'])
/** Downloadable scan states while U3 is open (D35); a configured scanner would allow 'clean' only. */
const DOWNLOADABLE_SCAN_STATES = new Set(['not_scanned', 'clean'])

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

async function assertOwner(c: SqlClient, ctx: OpContext, type: OwnerType, id: string): Promise<void> {
  if (!(await c.one(`SELECT 1 FROM ${OWNER_RULES[type].table} WHERE id = $1 AND organization_id = $2`, [id, ctx.actor.organizationId]))) {
    throw new AppError('NOT_FOUND', 'The record to attach the document to does not exist.')
  }
}

export async function listDocumentLinks(c: SqlClient, storage: DocumentStorage, ctx: OpContext, type: OwnerType, id: string): Promise<DocumentLinkView[]> {
  const rows = await c.many<Omit<DocumentLinkView, 'openable' | 'fileMissing'> & { storageKey: string }>(
    `SELECT l.id AS "linkId", d.id AS "documentId", l.purpose, d.original_name AS "originalName", d.mime_type AS "mimeType", d.byte_size AS "byteSize",
            d.created_at AS "uploadedAt", u.display_name AS "uploadedByName", d.storage_key AS "storageKey", d.scan_status AS "scanStatus"
     FROM document_links l JOIN documents d ON d.id = l.document_id LEFT JOIN users u ON u.id = d.uploaded_by
     WHERE l.organization_id = $1 AND l.entity_type = $2 AND l.entity_id = $3 AND l.removed_at IS NULL
     ORDER BY d.created_at DESC`,
    [ctx.actor.organizationId, type, id]
  )
  return Promise.all(
    rows.map(async ({ storageKey, ...r }) => ({
      ...r,
      purpose: r.purpose as DocumentPurpose,
      openable: INLINE_TYPES.has(extname(storageKey).slice(1)),
      fileMissing: !(await storage.exists(storageKey))
    }))
  )
}

/**
 * Validates and stores an upload, then links it to its owner. Bytes are written first; if the
 * database step fails, the object is removed again. Scan status is 'not_scanned' (D35, U3 open).
 */
export async function attachDocument(db: Db, storage: DocumentStorage, file: { fileName: string; data: Uint8Array; declaredMime: string | null }, raw: WebAttachInput, ctx: OpContext): Promise<DocumentLinkView> {
  const input = webAttachSchema.parse(raw)
  const type: OwnerType = input.entityType
  assertAnyPermission(ctx, OWNER_RULES[type].manage)
  await assertOwner(db, ctx, type, input.entityId)

  const ext = extname(file.fileName).slice(1).toLowerCase()
  const allowed = ALLOWED_DOCUMENT_TYPES[ext]
  if (!allowed) throw new AppError('VALIDATION_ERROR', `Files of type ".${ext || '?'}" cannot be attached. Allowed: ${Object.keys(ALLOWED_DOCUMENT_TYPES).join(', ')}.`)
  if (file.data.byteLength === 0) throw new AppError('VALIDATION_ERROR', 'The file is empty.')
  if (file.data.byteLength > MAX_DOCUMENT_BYTES) throw new AppError('VALIDATION_ERROR', `The file is larger than ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB.`)
  if (!SIGNATURES[ext]!(file.data)) throw new AppError('VALIDATION_ERROR', `The file content does not match its .${ext} extension.`)
  if (file.declaredMime && file.declaredMime !== 'application/octet-stream' && file.declaredMime !== allowed.mime) {
    throw new AppError('VALIDATION_ERROR', `The declared file type (${file.declaredMime}) does not match .${ext}.`)
  }

  const org = ctx.actor.organizationId
  const now = new Date().toISOString()
  const documentId = newId()
  const linkId = newId()
  const storageKey = `${org}/${type}s/${now.slice(0, 4)}/${now.slice(5, 7)}/${documentId}.${ext}`
  const originalName = (file.fileName.replace(/[\u0000-\u001f]/g, '').split(/[\\/]/).pop() ?? '').slice(-255) || `document.${ext}`
  const hash = sha256(file.data)
  await storage.put(storageKey, file.data)
  try {
    await db.tx(async (t) => {
      await assertOwner(t, ctx, type, input.entityId)
      await t.exec(
        `INSERT INTO documents (id, organization_id, storage_key, original_name, mime_type, byte_size, sha256, scan_status, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, 'not_scanned', $8)`,
        [documentId, org, storageKey, originalName, allowed.mime, file.data.byteLength, hash, ctx.actor.userId]
      )
      await t.exec('INSERT INTO document_links (id, organization_id, document_id, entity_type, entity_id, purpose, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
        linkId, org, documentId, type, input.entityId, input.purpose, ctx.actor.userId
      ])
      // A signed receipt attached to a pending handover acknowledges it (policy permitting, D39).
      if (type === 'handover' && input.purpose === 'handover') await recordSignedReceipt(t, ctx, input.entityId, documentId)
      await recordAudit(t, { ...auditFrom(ctx), eventType: 'document.attached', entityType: type, entityId: input.entityId, summary: { documentId, purpose: input.purpose, fileName: originalName, byteSize: file.data.byteLength, sha256: hash } })
    })
  } catch (err) {
    await storage.delete(storageKey).catch(() => undefined)
    throw err
  }
  return (await listDocumentLinks(db, storage, ctx, type, input.entityId)).find((l) => l.linkId === linkId)!
}

/** Soft-removes a link; the object and metadata stay for audit (retention policy undefined). */
export async function removeDocumentLink(db: Db, raw: RemoveDocumentLinkInput, ctx: OpContext): Promise<void> {
  const input = removeDocumentLinkSchema.parse(raw)
  await db.tx(async (t) => {
    const link = await t.one<{ t: OwnerType; e: string; d: string; r: string | null }>(
      'SELECT entity_type AS t, entity_id AS e, document_id AS d, removed_at AS r FROM document_links WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [input.linkId, ctx.actor.organizationId]
    )
    if (!link || !(link.t in OWNER_RULES)) throw new AppError('NOT_FOUND', 'Attachment not found.')
    assertAnyPermission(ctx, OWNER_RULES[link.t].manage)
    if (link.r) throw new AppError('STATE_CONFLICT', 'This attachment was already removed.')
    await t.exec('UPDATE document_links SET removed_at = now(), removed_by = $2, removal_reason = $3 WHERE id = $1', [input.linkId, ctx.actor.userId, input.reason])
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'document.unlinked', entityType: link.t, entityId: link.e, reason: input.reason, summary: { documentId: link.d } })
  })
}

export interface DocumentContent {
  data: Buffer
  originalName: string
  mimeType: string
  inline: boolean
}

/**
 * Authorized download: the caller must be able to view an active owner of the document in their
 * own organization; scan state must allow download; the checksum must still match.
 */
export async function readDocument(db: Db, storage: DocumentStorage, documentId: string, ctx: OpContext): Promise<DocumentContent> {
  const doc = await db.one<{ k: string; n: string; m: string; h: string; s: string }>(
    'SELECT storage_key AS k, original_name AS n, mime_type AS m, sha256 AS h, scan_status AS s FROM documents WHERE id = $1 AND organization_id = $2',
    [documentId, ctx.actor.organizationId]
  )
  if (!doc) throw new AppError('NOT_FOUND', 'Document not found.')
  const links = await db.many<{ t: OwnerType }>('SELECT entity_type AS t FROM document_links WHERE document_id = $1 AND organization_id = $2 AND removed_at IS NULL', [documentId, ctx.actor.organizationId])
  if (!links.some((l) => l.t in OWNER_RULES && OWNER_RULES[l.t].view.some((k) => ctx.actor.permissions.has(k)))) {
    throw new AppError('PERMISSION_DENIED', 'You do not have permission to open this document.')
  }
  if (!DOWNLOADABLE_SCAN_STATES.has(doc.s)) throw new AppError('STATE_CONFLICT', `This document cannot be downloaded (scan status: ${doc.s}).`)
  if (!(await storage.exists(doc.k))) throw new AppError('NOT_FOUND', 'The document file is missing from storage.')
  const data = await storage.get(doc.k)
  if (sha256(data) !== doc.h) throw new AppError('STATE_CONFLICT', 'The stored file no longer matches its recorded checksum and will not be served.')
  await recordAudit(db, { ...auditFrom(ctx), eventType: 'document.downloaded', entityType: 'document', entityId: documentId, summary: { byteSize: data.byteLength } })
  return { data, originalName: doc.n, mimeType: doc.m, inline: INLINE_TYPES.has(extname(doc.k).slice(1)) }
}
