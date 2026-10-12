import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, afterEach } from 'vitest'
import { createDb } from '../../server/src/db/sql'
import { createTestDatabase, type TestDatabase } from './db-helpers'
import { createApiSession, type ApiSession } from './session-helpers'

const run = promisify(execFile)

/**
 * Real pg_dump/pg_restore backup-and-restore drill (W8, TAS §21): dumps a live test database
 * with real data, restores it into a completely separate, isolated database, and verifies the
 * restored copy's data, relationships and permission grants independently -- not just that the
 * dump/restore commands exited with status 0 (TAS: "a successful backup job is not sufficient
 * evidence that recovery works"). This exercises the same `pg_dump`/`pg_restore` binaries and
 * custom-format dump the documented production backup procedure uses (docs/BACKUP_RECOVERY.md).
 */
describe('backup and restore drill', () => {
  const sessions: ApiSession[] = []
  const dbs: TestDatabase[] = []
  let tmpDir: string | undefined
  afterEach(async () => {
    for (const s of sessions.splice(0)) await s.close()
    for (const d of dbs.splice(0)) await d.drop()
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = undefined
  })

  it('restores a dump into an isolated database with data, relationships and permissions intact', async () => {
    const a = await createApiSession()
    sessions.push(a)
    const category = await a.ok('categories.create', { code: 'BK1', name: 'Backup Drill Category', description: null, assetDomain: 'it', trackingMode: 'individual', serialRequired: false, serialUnique: false })
    const asset = await a.ok('assets.create', {
      categoryId: category.id, modelId: null, manufacturer: 'Dell', modelName: 'Latitude', serialNumber: 'BK-SN-1', specifications: null, condition: 'good', operationalStatus: 'ready',
      locationId: null, supplierId: null, purchaseDate: '2026-01-01', acquisitionCost: '10000.00', invoiceReference: null, purchaseReference: null, warrantyStart: null, warrantyEnd: null, notes: null
    } as never)

    tmpDir = mkdtempSync(join(tmpdir(), 'bpoam-backup-'))
    const dumpFile = join(tmpDir, 'backup.dump')
    await run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--file=${dumpFile}`, a.s.tdb.url])

    const restored = await createTestDatabase({ migrate: false })
    dbs.push(restored)
    await run('pg_restore', ['--no-owner', '--no-privileges', '--clean', '--if-exists', `--dbname=${restored.url}`, dumpFile])

    const check = createDb(restored.url, { max: 2, applicationName: 'bpoam-restore-check' })
    try {
      const assetCount = (await check.one<{ n: string }>('SELECT COUNT(*) AS n FROM assets'))!.n
      expect(Number(assetCount)).toBeGreaterThanOrEqual(1)
      const restoredAsset = await check.one<{ code: string; categoryName: string; cost: number }>(
        "SELECT a.asset_code AS code, c.name AS \"categoryName\", a.acquisition_cost_minor AS cost FROM assets a JOIN asset_categories c ON c.id = a.category_id WHERE a.serial_number = 'BK-SN-1'"
      )
      expect(restoredAsset).toMatchObject({ categoryName: 'Backup Drill Category', cost: 10000 * 100 })

      // Permissions and role grants survive the round trip (not just raw tables).
      const permCount = (await check.one<{ n: string }>(
        `SELECT COUNT(*) AS n FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.key = 'super_admin' AND rp.permission_key = 'assets.view'`
      ))!.n
      expect(Number(permCount)).toBeGreaterThanOrEqual(1)

      // Referential integrity: every asset's category still resolves (no dangling FK after restore).
      const orphanCount = (await check.one<{ n: string }>(
        'SELECT COUNT(*) AS n FROM assets a WHERE NOT EXISTS (SELECT 1 FROM asset_categories c WHERE c.id = a.category_id)'
      ))!.n
      expect(Number(orphanCount)).toBe(0)

      // A representative workflow still runs against the restored copy: the same search query the
      // live assets.search service issues returns the migrated asset.
      const found = await check.one<{ code: string }>("SELECT asset_code AS code FROM assets WHERE serial_number = 'BK-SN-1' AND lifecycle_status = 'active'")
      expect(found?.code).toBe(asset.assetCode)
    } finally {
      await check.close()
    }
  })
})
