import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, resolve, sep } from 'node:path'
import type { Database as DB } from 'better-sqlite3'
import type { DocumentLinkView } from '@shared/api'
import { ALLOWED_DOCUMENT_TYPES, MAX_DOCUMENT_BYTES, type DocumentOwnerType, type DocumentPurpose } from '@shared/assets'
import { attachDocumentSchema, removeDocumentLinkSchema, type AttachDocumentInput, type RemoveDocumentLinkInput } from '@shared/assetSchemas'
import { AppError } from '../app/errors'
import { newId, nowIso } from '../app/ids'
import { assertPermission } from '../auth/permissions'
import type { PermissionKey } from '@shared/permissions'
import { recordAudit } from './audit'
import type { OpContext } from './context'
import { getOrganizationId } from './setup'

/** Absolute documents folder; set once by the container (files live outside the database). */
let documentsRoot: string | null = null
export function setDocumentsRoot(dir: string): void {
  documentsRoot = dir
}
function root(): string {
  if (!documentsRoot) throw new AppError('INTERNAL_ERROR', 'Document storage is not configured.')
  return documentsRoot
}

/** Who may view / change documents per owner type. Extended as new owner types arrive. */
const OWNER_RULES: Record<DocumentOwnerType, { table: string; view: PermissionKey; manage: PermissionKey }> = {
  asset: { table: 'assets', view: 'assets.view', manage: 'assets.update' }
}

/** Magic-byte checks so a renamed executable cannot pose as a PDF or image. */
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

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

function safePath(storageKey: string): string {
  const base = resolve(root())
  const full = resolve(base, storageKey)
  if (!full.startsWith(base + sep)) throw new AppError('INTERNAL_ERROR', 'Invalid document storage key.')
  return full
}

function assertOwner(db: DB, type: DocumentOwnerType, id: string): void {
  if (!db.prepare(`SELECT 1 FROM ${OWNER_RULES[type].table} WHERE id = ?`).get(id)) {
    throw new AppError('NOT_FOUND', 'The record to attach the document to does not exist.')
  }
}

export function listDocumentLinks(db: DB, type: DocumentOwnerType, id: string): DocumentLinkView[] {
  const rows = db
    .prepare(
      `SELECT l.id AS linkId, d.id AS documentId, l.purpose, d.original_name AS originalName, d.mime_type AS mimeType, d.byte_size AS byteSize,
              d.created_at AS uploadedAt, u.display_name AS uploadedByName, d.storage_key AS storageKey
       FROM document_links l JOIN documents d ON d.id = l.document_id LEFT JOIN users u ON u.id = d.uploaded_by
       WHERE l.entity_type = ? AND l.entity_id = ? AND l.removed_at IS NULL
       ORDER BY d.created_at DESC`
    )
    .all(type, id) as Array<Omit<DocumentLinkView, 'openable' | 'fileMissing'> & { storageKey: string }>
  return rows.map(({ storageKey, ...r }) => ({
    ...r,
    purpose: r.purpose as DocumentPurpose,
    openable: ALLOWED_DOCUMENT_TYPES[extname(storageKey).slice(1)]?.openable ?? false,
    fileMissing: !existsSync(safePath(storageKey))
  }))
}

/**
 * Stores an uploaded file under a generated key and links it to its owner. The file is
 * written first; if the database step fails the file is removed again.
 */
export async function attachDocument(db: DB, file: { fileName: string; data: Uint8Array }, raw: AttachDocumentInput, ctx: OpContext): Promise<DocumentLinkView> {
  const input = attachDocumentSchema.parse(raw)
  const rule = OWNER_RULES[input.entityType]
  assertPermission(ctx.actor.permissions, rule.manage)
  assertOwner(db, input.entityType, input.entityId)

  const ext = extname(file.fileName).slice(1).toLowerCase()
  const type = ALLOWED_DOCUMENT_TYPES[ext]
  if (!type) throw new AppError('VALIDATION_ERROR', `Files of type ".${ext || '?'}" cannot be attached. Allowed: ${Object.keys(ALLOWED_DOCUMENT_TYPES).join(', ')}.`)
  if (file.data.byteLength === 0) throw new AppError('VALIDATION_ERROR', 'The file is empty.')
  if (file.data.byteLength > MAX_DOCUMENT_BYTES) throw new AppError('VALIDATION_ERROR', `The file is larger than ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB.`)
  if (!SIGNATURES[ext]!(file.data)) throw new AppError('VALIDATION_ERROR', `The file content does not match its .${ext} extension.`)

  const now = nowIso()
  const documentId = newId()
  const linkId = newId()
  const storageKey = `${input.entityType}s/${now.slice(0, 4)}/${now.slice(5, 7)}/${documentId}.${ext}`
  const target = safePath(storageKey)
  await mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  await writeFile(tmp, file.data)
  await rename(tmp, target)

  const originalName = file.fileName.replace(/[\u0000-\u001f]/g, '').slice(-255) || `document.${ext}`
  const hash = sha256(file.data)
  try {
    db.transaction(() => {
      assertOwner(db, input.entityType, input.entityId)
      db.prepare(
        `INSERT INTO documents (id, organization_id, storage_key, original_name, mime_type, byte_size, sha256, uploaded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(documentId, getOrganizationId(db), storageKey, originalName, type.mime, file.data.byteLength, hash, ctx.actor.userId, now)
      db.prepare('INSERT INTO document_links (id, document_id, entity_type, entity_id, purpose, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        linkId, documentId, input.entityType, input.entityId, input.purpose, now, ctx.actor.userId
      )
      recordAudit(db, {
        actorUserId: ctx.actor.userId,
        eventType: 'document.attached',
        entityType: input.entityType,
        entityId: input.entityId,
        correlationId: ctx.correlationId,
        summary: { documentId, purpose: input.purpose, fileName: originalName, byteSize: file.data.byteLength, sha256: hash }
      })
    })()
  } catch (err) {
    await rm(target, { force: true }).catch(() => undefined)
    throw err
  }
  return listDocumentLinks(db, input.entityType, input.entityId).find((l) => l.linkId === linkId)!
}

/** Soft-removes a link. The file and its metadata stay for audit and backups. */
export function removeDocumentLink(db: DB, raw: RemoveDocumentLinkInput, ctx: OpContext): void {
  const input = removeDocumentLinkSchema.parse(raw)
  db.transaction(() => {
    const link = db.prepare('SELECT entity_type AS t, entity_id AS e, document_id AS d, removed_at AS r FROM document_links WHERE id = ?').get(input.linkId) as
      | { t: DocumentOwnerType; e: string; d: string; r: string | null }
      | undefined
    if (!link || !(link.t in OWNER_RULES)) throw new AppError('NOT_FOUND', 'Attachment not found.')
    assertPermission(ctx.actor.permissions, OWNER_RULES[link.t].manage)
    if (link.r) throw new AppError('STATE_CONFLICT', 'This attachment was already removed.')
    db.prepare('UPDATE document_links SET removed_at = ?, removed_by = ? WHERE id = ?').run(nowIso(), ctx.actor.userId, input.linkId)
    recordAudit(db, {
      actorUserId: ctx.actor.userId,
      eventType: 'document.unlinked',
      entityType: link.t,
      entityId: link.e,
      reason: input.reason,
      correlationId: ctx.correlationId,
      summary: { documentId: link.d }
    })
  })()
}

export interface ResolvedDocument {
  path: string
  originalName: string
  openable: boolean
}

/**
 * Returns the stored file for a document the caller may view (via an active link to an
 * owner they can see), after checking it still matches its recorded checksum.
 */
export function resolveDocument(db: DB, documentId: string, ctx: OpContext): ResolvedDocument {
  const doc = db.prepare('SELECT storage_key AS k, original_name AS n, sha256 AS h FROM documents WHERE id = ?').get(documentId) as { k: string; n: string; h: string } | undefined
  if (!doc) throw new AppError('NOT_FOUND', 'Document not found.')
  const links = db.prepare('SELECT entity_type AS t FROM document_links WHERE document_id = ? AND removed_at IS NULL').all(documentId) as Array<{ t: DocumentOwnerType }>
  if (!links.some((l) => l.t in OWNER_RULES && ctx.actor.permissions.has(OWNER_RULES[l.t].view))) {
    throw new AppError('PERMISSION_DENIED', 'You do not have permission to open this document.')
  }
  const path = safePath(doc.k)
  if (!existsSync(path)) throw new AppError('NOT_FOUND', 'The document file is missing from storage. Restore it from a backup.')
  if (sha256(readFileSync(path)) !== doc.h) throw new AppError('STATE_CONFLICT', 'The stored file no longer matches its recorded checksum and will not be opened.')
  return { path, originalName: doc.n, openable: ALLOWED_DOCUMENT_TYPES[extname(doc.k).slice(1)]?.openable ?? false }
}

