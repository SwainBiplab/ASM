import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import type { Database as DB } from 'better-sqlite3'
import type { BackupKind, BackupSummary, BackupValidation, RestoreOutcome } from '@shared/api'
import { backupIdSchema, restoreInputSchema, type RestoreInput } from '@shared/schemas'
import { AppError, isAppError } from '../app/errors'
import { nowIso } from '../app/ids'
import { assertPermission } from '../auth/permissions'
import { foreignKeyCheck, integrityCheck, openDatabase } from '../database/connection'
import type { DatabaseManager } from '../database/manager'
import { MIGRATIONS } from '../database/migrations'
import { currentSchemaVersion, planMigrations } from '../database/migrator'
import type { Logger } from '../logging/logger'
import { recordAudit } from '../services/audit'
import type { OpContext } from '../services/context'

export const MANIFEST_FILE = 'manifest.json'
export const BACKUP_DB_FILE = 'database.sqlite'
export const BACKUP_DOCS_DIR = 'documents'
const MANIFEST_FORMAT = 1

export interface BackupManifest {
  formatVersion: number
  backupId: string
  kind: BackupKind
  createdAt: string
  appVersion: string
  schemaVersion: number
  database: { file: string; sha256: string; bytes: number }
  documents: Array<{ path: string; sha256: string; bytes: number }>
  counts: Record<string, number>
  verified: boolean
}

const COUNTED_TABLES = ['organization_profile', 'users', 'roles', 'audit_events'] as const

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function listFilesRecursive(root: string): Promise<string[]> {
  if (!existsSync(root)) return []
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)).split(sep).join('/'))
    .sort()
}

/** Rejects absolute or parent-escaping paths read from a (possibly tampered) manifest. */
function safeRelative(path: string): boolean {
  if (!path || isAbsolute(path) || path.includes('\0')) return false
  const norm = normalize(path)
  return !norm.startsWith('..') && !isAbsolute(norm)
}

const compactTimestamp = (iso: string): string => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '')

export class BackupService {
  constructor(
    private readonly dbm: DatabaseManager,
    private readonly logger: Logger,
    private readonly appVersion: string
  ) {}

  private get backupsDir(): string {
    return this.dbm.paths.backupsDir
  }

  private dirFor(backupId: string): string {
    const id = backupIdSchema.parse(backupId)
    const dir = resolve(this.backupsDir, id)
    if (!dir.startsWith(resolve(this.backupsDir) + sep)) throw new AppError('VALIDATION_ERROR', 'Invalid backup identifier.')
    return dir
  }

  /** Manual backup requested by a user. */
  async create(ctx: OpContext): Promise<BackupSummary> {
    assertPermission(ctx.actor.permissions, 'backup.create')
    return this.createFrom(this.dbm.db, 'manual', ctx.actor.userId, ctx.correlationId)
  }

  /**
   * Produces a consistent backup generation: SQLite online backup + document copies +
   * checksummed manifest. Written to a `.partial` folder and renamed only once verified.
   */
  async createFrom(db: DB, kind: BackupKind, actorUserId: string | null, correlationId: string): Promise<BackupSummary> {
    const createdAt = nowIso()
    const backupId = `${compactTimestamp(createdAt)}-${kind}-${randomBytes(4).toString('hex')}`
    const finalDir = join(this.backupsDir, backupId)
    const partialDir = `${finalDir}.partial`
    try {
      await mkdir(join(partialDir, BACKUP_DOCS_DIR), { recursive: true })
      const dbCopy = join(partialDir, BACKUP_DB_FILE)
      await db.backup(dbCopy)

      const documents: BackupManifest['documents'] = []
      for (const rel of await listFilesRecursive(this.dbm.paths.documentsDir)) {
        const src = join(this.dbm.paths.documentsDir, rel)
        const dest = join(partialDir, BACKUP_DOCS_DIR, rel)
        await mkdir(join(dest, '..'), { recursive: true })
        await copyFile(src, dest)
        documents.push({ path: rel, sha256: await sha256File(dest), bytes: (await stat(dest)).size })
      }

      const copy = openDatabase(dbCopy, { readonly: true, fileMustExist: true })
      let verified: boolean
      let schemaVersion: number
      const counts: Record<string, number> = {}
      try {
        verified = integrityCheck(copy, 'full').length === 0 && foreignKeyCheck(copy) === 0
        schemaVersion = currentSchemaVersion(copy)
        for (const t of COUNTED_TABLES) counts[t] = (copy.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n
      } finally {
        copy.close()
      }
      if (!verified) throw new AppError('BACKUP_FAILED', 'The backup copy failed its integrity check.')

      const manifest: BackupManifest = {
        formatVersion: MANIFEST_FORMAT,
        backupId,
        kind,
        createdAt,
        appVersion: this.appVersion,
        schemaVersion,
        database: { file: BACKUP_DB_FILE, sha256: await sha256File(dbCopy), bytes: (await stat(dbCopy)).size },
        documents,
        counts,
        verified
      }
      await writeFile(join(partialDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8')
      await rename(partialDir, finalDir)

      db.transaction(() => {
        db.prepare(
          `INSERT INTO backup_history (id, created_at, kind, relative_path, checksum, schema_version, app_version, status,
                                       actor_user_id, database_bytes, document_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?, ?)`
        ).run(backupId, createdAt, kind, backupId, manifest.database.sha256, schemaVersion, this.appVersion, actorUserId, manifest.database.bytes, documents.length)
        recordAudit(db, {
          actorUserId,
          eventType: 'backup.created',
          entityType: 'backup',
          entityId: backupId,
          correlationId,
          summary: { kind, schemaVersion, documents: documents.length, bytes: manifest.database.bytes }
        })
      })()
      this.logger.info('backup', 'Backup created', { backupId, kind, correlationId })
      return toSummary(manifest)
    } catch (err) {
      await rm(partialDir, { recursive: true, force: true }).catch(() => undefined)
      this.logger.error('backup', 'Backup failed', { kind, correlationId, error: err })
      if (isAppError(err)) throw err
      throw new AppError('BACKUP_FAILED', `Backup failed: ${(err as Error).message}`)
    }
  }

  /** Lists completed backup generations (ignores `.partial` folders), newest first. */
  async list(ctx?: OpContext): Promise<BackupSummary[]> {
    if (ctx) assertPermission(ctx.actor.permissions, 'backup.create')
    if (!existsSync(this.backupsDir)) return []
    const out: BackupSummary[] = []
    for (const entry of await readdir(this.backupsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !backupIdSchema.safeParse(entry.name).success) continue
      const manifest = await this.readManifest(entry.name).catch(() => null)
      if (manifest) out.push(toSummary(manifest))
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  private async readManifest(backupId: string): Promise<BackupManifest> {
    const raw = await readFile(join(this.dirFor(backupId), MANIFEST_FILE), 'utf8')
    const m = JSON.parse(raw) as BackupManifest
    if (m.formatVersion !== MANIFEST_FORMAT || m.backupId !== backupId) throw new Error('Unrecognized manifest')
    return m
  }

  /** Verifies manifest, checksums, SQLite integrity and schema compatibility. */
  async validate(backupId: string, ctx?: OpContext): Promise<BackupValidation> {
    if (ctx) assertPermission(ctx.actor.permissions, 'backup.create')
    const problems: string[] = []
    let schemaVersion: number | null = null
    const dir = this.dirFor(backupId)
    let manifest: BackupManifest
    try {
      manifest = await this.readManifest(backupId)
    } catch (err) {
      return { backupId, valid: false, problems: [`Manifest missing or unreadable: ${(err as Error).message}`], schemaVersion }
    }

    const dbFile = join(dir, BACKUP_DB_FILE)
    if (!existsSync(dbFile)) {
      problems.push('Database file is missing from the backup.')
    } else {
      if ((await sha256File(dbFile)) !== manifest.database.sha256) problems.push('Database checksum does not match the manifest.')
      try {
        const copy = openDatabase(dbFile, { readonly: true, fileMustExist: true })
        try {
          const integrity = integrityCheck(copy, 'full')
          if (integrity.length) problems.push(`Database integrity check failed: ${integrity.slice(0, 3).join('; ')}`)
          if (foreignKeyCheck(copy) > 0) problems.push('Database has foreign-key violations.')
          planMigrations(copy, MIGRATIONS)
          schemaVersion = currentSchemaVersion(copy)
        } finally {
          copy.close()
        }
      } catch (err) {
        problems.push(`Database cannot be used: ${(err as Error).message}`)
      }
    }

    for (const doc of manifest.documents) {
      if (!safeRelative(doc.path)) {
        problems.push(`Unsafe document path in manifest: ${doc.path}`)
        continue
      }
      const file = join(dir, BACKUP_DOCS_DIR, doc.path)
      if (!existsSync(file)) problems.push(`Document missing: ${doc.path}`)
      else if ((await sha256File(file)) !== doc.sha256) problems.push(`Document checksum mismatch: ${doc.path}`)
    }
    return { backupId, valid: problems.length === 0, problems, schemaVersion }
  }

  /**
   * Restores database and documents as one set (TAS §13.2): validate, take a safety
   * backup, swap files, reopen + migrate + check, and roll back on any failure.
   */
  async restore(rawInput: RestoreInput, ctx: OpContext, actorUsername: string): Promise<RestoreOutcome> {
    assertPermission(ctx.actor.permissions, 'backup.restore')
    const input = restoreInputSchema.parse(rawInput)
    const validation = await this.validate(input.backupId)
    if (!validation.valid) {
      throw new AppError('RESTORE_FAILED', `The backup failed validation: ${validation.problems.slice(0, 3).join(' ')}`)
    }

    let safetyBackupId: string | null = null
    try {
      safetyBackupId = (await this.createFrom(this.dbm.db, 'pre_restore', ctx.actor.userId, ctx.correlationId)).backupId
    } catch (err) {
      // Never proceed without an alternative copy of the current data.
      throw new AppError('RESTORE_FAILED', `Restore cancelled: the pre-restore safety backup failed (${(err as Error).message}).`)
    }

    const { databaseFile, documentsDir } = this.dbm.paths
    const sourceDir = this.dirFor(input.backupId)
    const stamp = compactTimestamp(nowIso())
    const stagedDb = `${databaseFile}.restoring`
    const stagedDocs = `${documentsDir}.restoring`
    const aside = (p: string): string => `${p}.pre-restore-${stamp}`
    const sidecars = ['-journal', '-wal', '-shm'].map((s) => databaseFile + s)

    await rm(stagedDb, { force: true })
    await rm(stagedDocs, { recursive: true, force: true })
    await copyFile(join(sourceDir, BACKUP_DB_FILE), stagedDb)
    const manifest = await this.readManifest(input.backupId)
    if ((await sha256File(stagedDb)) !== manifest.database.sha256) {
      await rm(stagedDb, { force: true })
      throw new AppError('RESTORE_FAILED', 'Copied database did not match the backup checksum.')
    }
    const backupDocs = join(sourceDir, BACKUP_DOCS_DIR)
    if (existsSync(backupDocs)) await cp(backupDocs, stagedDocs, { recursive: true })
    else await mkdir(stagedDocs, { recursive: true })

    this.dbm.close()
    const moved: Array<[string, string]> = []
    const moveAside = async (p: string): Promise<void> => {
      if (existsSync(p)) {
        await rename(p, aside(p))
        moved.push([aside(p), p])
      }
    }
    try {
      await moveAside(databaseFile)
      for (const s of sidecars) await moveAside(s)
      await moveAside(documentsDir)
      await rename(stagedDb, databaseFile)
      await rename(stagedDocs, documentsDir)

      await this.dbm.open()
      const db = this.dbm.db
      if (foreignKeyCheck(db) > 0) throw new Error('Restored database has foreign-key violations.')
      const actorExists = Boolean(db.prepare('SELECT 1 FROM users WHERE id = ?').get(ctx.actor.userId))
      recordAudit(db, {
        actorUserId: actorExists ? ctx.actor.userId : null,
        eventType: 'backup.restored',
        entityType: 'backup',
        entityId: input.backupId,
        correlationId: ctx.correlationId,
        summary: { restoredBackupId: input.backupId, safetyBackupId, performedBy: actorUsername }
      })
    } catch (err) {
      this.logger.error('backup', 'Restore failed; rolling back', { correlationId: ctx.correlationId, error: err })
      this.dbm.close()
      await rm(databaseFile, { force: true }).catch(() => undefined)
      await rm(documentsDir, { recursive: true, force: true }).catch(() => undefined)
      for (const [from, to] of moved.reverse()) await rename(from, to).catch(() => undefined)
      await rm(stagedDb, { force: true }).catch(() => undefined)
      await rm(stagedDocs, { recursive: true, force: true }).catch(() => undefined)
      await this.dbm.open().catch((e: unknown) => this.logger.error('backup', 'Reopen after rollback failed', { error: e }))
      throw new AppError('RESTORE_FAILED', `Restore failed and the previous data was put back: ${(err as Error).message}`)
    }

    // The verified safety backup now holds the previous data; the aside copies are redundant.
    for (const [asidePath] of moved) await rm(asidePath, { recursive: true, force: true }).catch(() => undefined)
    this.logger.info('backup', 'Restore completed', { backupId: input.backupId, safetyBackupId, correlationId: ctx.correlationId })
    return { restoredBackupId: input.backupId, safetyBackupId, schemaVersion: this.dbm.schemaVersion() }
  }
}

function toSummary(m: BackupManifest): BackupSummary {
  return {
    backupId: m.backupId,
    kind: m.kind,
    createdAt: m.createdAt,
    appVersion: m.appVersion,
    schemaVersion: m.schemaVersion,
    databaseBytes: m.database.bytes,
    documentCount: m.documents.length,
    verified: m.verified
  }
}
