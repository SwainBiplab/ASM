import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BackupService } from '../../src/main/backup/backupService'
import { DatabaseManager } from '../../src/main/database/manager'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../../src/main/database/migrations'
import { silentLogger } from '../../src/main/logging/logger'
import { ADMIN, createReadyApp, createTestApp, type TestApp } from '../helpers'

const apps: TestApp[] = []
afterEach(() => apps.splice(0).forEach((a) => a.cleanup()))
const track = (a: TestApp): TestApp => (apps.push(a), a)

const NEW_USER = { username: 'after.backup', displayName: 'After Backup', password: 'After-Backup-1', roleKeys: ['auditor'] }

function writeDocument(app: TestApp, rel: string, content: string): void {
  const file = join(app.container.paths.documentsDir, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
}

describe('backup creation and validation', () => {
  it('creates a verified, checksummed backup including documents', async () => {
    const app = track(await createReadyApp())
    writeDocument(app, 'invoices/inv-001.pdf', 'invoice-bytes')
    const b = await app.ok('backup.create')
    expect(b).toMatchObject({ kind: 'manual', verified: true, schemaVersion: LATEST_SCHEMA_VERSION, documentCount: 1 })

    const dir = join(app.container.paths.backupsDir, b.backupId)
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    expect(manifest.documents[0].path).toBe('invoices/inv-001.pdf')
    expect(manifest.counts.users).toBe(1)
    expect((await app.ok('backup.validate', { backupId: b.backupId })).valid).toBe(true)
    expect((await app.ok('backup.list')).map((x) => x.backupId)).toContain(b.backupId)
    expect((await app.ok('audit.list', { page: 1, pageSize: 5, eventType: 'backup.created' })).total).toBe(1)
  })

  it('keeps multiple generations', async () => {
    const app = track(await createReadyApp())
    const a = await app.ok('backup.create')
    const b = await app.ok('backup.create')
    expect(a.backupId).not.toBe(b.backupId)
    expect((await app.ok('backup.list')).length).toBe(2)
  })

  it('detects a tampered database file', async () => {
    const app = track(await createReadyApp())
    const b = await app.ok('backup.create')
    const dbFile = join(app.container.paths.backupsDir, b.backupId, 'database.sqlite')
    const bytes = readFileSync(dbFile)
    bytes[bytes.length - 10] = bytes[bytes.length - 10]! ^ 0xff
    writeFileSync(dbFile, bytes)
    const v = await app.ok('backup.validate', { backupId: b.backupId })
    expect(v.valid).toBe(false)
    expect(v.problems.join(' ')).toMatch(/checksum/i)
  })

  it('detects missing documents and a missing manifest', async () => {
    const app = track(await createReadyApp())
    writeDocument(app, 'warranties/w.txt', 'warranty')
    const b = await app.ok('backup.create')
    const dir = join(app.container.paths.backupsDir, b.backupId)
    rmSync(join(dir, 'documents', 'warranties', 'w.txt'))
    expect((await app.ok('backup.validate', { backupId: b.backupId })).problems.join(' ')).toMatch(/Document missing/)
    rmSync(join(dir, 'manifest.json'))
    expect((await app.ok('backup.validate', { backupId: b.backupId })).valid).toBe(false)
  })

  it('rejects path-like backup identifiers', async () => {
    const app = track(await createReadyApp())
    expect(await app.call('backup.validate', { backupId: '../../database' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
  })

  it('ignores interrupted (.partial) backups', async () => {
    const app = track(await createReadyApp())
    mkdirSync(join(app.container.paths.backupsDir, '20260101T000000Z-manual-deadbeef.partial'), { recursive: true })
    expect(await app.ok('backup.list')).toEqual([])
  })
})

describe('restore', () => {
  it('restores database and documents as a set, with a safety backup', async () => {
    const app = track(await createReadyApp())
    writeDocument(app, 'invoices/original.txt', 'original')
    const b = await app.ok('backup.create')

    await app.ok('users.create', NEW_USER)
    writeDocument(app, 'invoices/later.txt', 'later')
    writeFileSync(join(app.container.paths.documentsDir, 'invoices', 'original.txt'), 'modified')

    const outcome = await app.ok('backup.restore', { backupId: b.backupId, confirmation: 'RESTORE' })
    expect(outcome.restoredBackupId).toBe(b.backupId)
    expect(outcome.safetyBackupId).toMatch(/pre_restore/)

    // Session ends after restore; sign in again against restored data.
    expect(await app.call('users.list')).toMatchObject({ ok: false, error: { code: 'NOT_AUTHENTICATED' } })
    await app.ok('session.login', { username: ADMIN.username, password: ADMIN.password })
    expect((await app.ok('users.list')).map((u) => u.username)).toEqual([ADMIN.username])

    const docs = app.container.paths.documentsDir
    expect(readFileSync(join(docs, 'invoices', 'original.txt'), 'utf8')).toBe('original')
    expect(existsSync(join(docs, 'invoices', 'later.txt'))).toBe(false)
    expect((await app.ok('audit.list', { page: 1, pageSize: 5, eventType: 'backup.restored' })).total).toBe(1)

    // The safety backup holds the pre-restore state and can itself be restored.
    expect((await app.ok('backup.validate', { backupId: outcome.safetyBackupId! })).valid).toBe(true)
    await app.ok('backup.restore', { backupId: outcome.safetyBackupId!, confirmation: 'RESTORE' })
    await app.ok('session.login', { username: ADMIN.username, password: ADMIN.password })
    expect((await app.ok('users.list')).map((u) => u.username).sort()).toEqual([NEW_USER.username, ADMIN.username].sort())
    expect(readFileSync(join(docs, 'invoices', 'later.txt'), 'utf8')).toBe('later')
  })

  it('requires the explicit confirmation phrase', async () => {
    const app = track(await createReadyApp())
    const b = await app.ok('backup.create')
    expect(await app.call('backup.restore', { backupId: b.backupId, confirmation: 'yes' as never })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR' }
    })
  })

  it('requires the backup.restore permission', async () => {
    const app = track(await createReadyApp())
    const b = await app.ok('backup.create')
    await app.ok('users.create', { ...NEW_USER, roleKeys: ['asset_manager'] })
    await app.ok('session.logout')
    await app.ok('session.login', { username: NEW_USER.username, password: NEW_USER.password })
    expect((await app.call('backup.create')).ok).toBe(true)
    expect(await app.call('backup.restore', { backupId: b.backupId, confirmation: 'RESTORE' })).toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED' }
    })
  })

  it('refuses a corrupt backup and leaves live data untouched', async () => {
    const app = track(await createReadyApp())
    const b = await app.ok('backup.create')
    await app.ok('users.create', NEW_USER)
    writeFileSync(join(app.container.paths.backupsDir, b.backupId, 'database.sqlite'), 'garbage')
    const before = readdirSync(app.container.paths.backupsDir).length

    expect(await app.call('backup.restore', { backupId: b.backupId, confirmation: 'RESTORE' })).toMatchObject({
      ok: false,
      error: { code: 'RESTORE_FAILED' }
    })
    expect((await app.ok('users.list')).length).toBe(2)
    expect(readdirSync(app.container.paths.backupsDir).length).toBe(before)
  })
})

describe('pre-migration backup', () => {
  it('produces a valid backup of the old schema before upgrading', async () => {
    const app = track(await createReadyApp())
    app.container.shutdown()
    const paths = app.container.paths
    const upgrade = { version: LATEST_SCHEMA_VERSION + 1, name: 'probe', sql: 'CREATE TABLE probe (id TEXT PRIMARY KEY) STRICT;' }
    let service: BackupService | null = null
    const dbm: DatabaseManager = new DatabaseManager(
      paths,
      silentLogger,
      '1.1.0',
      { beforeMigrate: async (db) => void (await service!.createFrom(db, 'pre_migration', null, 'test')) },
      [...MIGRATIONS, upgrade]
    )
    service = new BackupService(dbm, silentLogger, '1.1.0')
    await dbm.open()
    dbm.close()

    const reopened = track(await createTestApp(app.root))
    const ids = readdirSync(paths.backupsDir).filter((d) => d.includes('pre_migration'))
    expect(ids).toHaveLength(1)
    const manifest = JSON.parse(readFileSync(join(paths.backupsDir, ids[0]!, 'manifest.json'), 'utf8'))
    expect(manifest.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    // The current build refuses the now-newer database instead of corrupting it.
    expect(reopened.container.startup.status).toBe('database_error')
  })
})
