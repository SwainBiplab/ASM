import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import type { BrowserWindow } from 'electron'
import type { Result } from '@shared/errors'
import { sqliteVersion } from '../database/connection'
import type { AppContainer } from './container'

type Dispatch = (command: string, payload: unknown) => Promise<Result<unknown>>

interface Check {
  name: string
  ok: boolean
  detail?: string
}

/**
 * Packaged-app smoke test (`--smoke-test --smoke-report=<file>`): proves the native SQLite
 * module, migrations, auth, backup and the sandboxed renderer bridge work inside the
 * installed build. Run against a throwaway data directory (BPOAM_DATA_DIR).
 */
export async function runSmokeTest(c: AppContainer, dispatch: Dispatch, win: BrowserWindow, reportPath: string): Promise<number> {
  const checks: Check[] = []
  const check = async (name: string, fn: () => Promise<string | void> | string | void): Promise<void> => {
    try {
      const detail = await fn()
      checks.push({ name, ok: true, ...(detail ? { detail } : {}) })
    } catch (err) {
      checks.push({ name, ok: false, detail: (err as Error).message })
    }
  }
  const expectOk = async (command: string, payload?: unknown): Promise<unknown> => {
    const r = await dispatch(command, payload)
    if (!r.ok) throw new Error(`${command}: ${r.error.code} ${r.error.message}`)
    return r.data
  }

  await check('database opened', () => {
    if (c.startup.status === 'database_error') throw new Error(c.startup.error?.message ?? 'database error')
    return `status=${c.startup.status} schema=${c.dbm.schemaVersion()} sqlite=${sqliteVersion(c.dbm.db)}`
  })

  const password = randomBytes(12).toString('hex')
  if (c.startup.status === 'setup_required') {
    await check('first-run setup', async () => {
      await expectOk('setup.complete', {
        organization: { legalName: 'Smoke Test Org', displayName: 'Smoke', baseCurrency: 'INR', timezone: 'Asia/Kolkata' },
        admin: { username: 'smoke.admin', displayName: 'Smoke Admin', password }
      })
    })
    await check('login', async () => {
      await expectOk('session.login', { username: 'smoke.admin', password })
    })
    await check('permission enforcement', async () => {
      const r = await dispatch('users.create', { username: 'x', displayName: '', password: 'short', roleKeys: [] })
      if (r.ok || r.error.code !== 'VALIDATION_ERROR') throw new Error('invalid payload was not rejected')
    })
    await check('organization + CSV employee import', async () => {
      const dept = (await expectOk('departments.create', { code: 'SMK', name: 'Smoke Dept', managerEmployeeId: null, notes: null })) as { id: string }
      c.pickImportFile = async () => ({
        fileName: 'smoke.csv',
        data: new TextEncoder().encode('Employee ID,Full Name,Department,Manager ID\r\nS1,"Lead, Smoke",SMK,\r\nS2,Agent Smoke,Smoke Dept,S1\r\n')
      })
      const preview = (await expectOk('employees.importSelectFile')) as { importId: string; mapping: unknown; counts: { accepted: number } }
      if (preview.counts.accepted !== 2) throw new Error(`expected 2 accepted rows, got ${preview.counts.accepted}`)
      const result = (await expectOk('employees.importCommit', { importId: preview.importId, mapping: preview.mapping, dateFormat: 'YYYY-MM-DD', skipInvalidRows: false })) as { imported: number }
      const page = (await expectOk('employees.search', { departmentId: dept.id })) as { total: number }
      if (result.imported !== 2 || page.total !== 2) throw new Error('imported employees not found')
      return 'csv-parse loaded; 2 employees imported'
    })
    await check('asset register + labels', async () => {
      const cat = (await expectOk('categories.create', { code: 'SMK', name: 'Smoke Laptop', description: null, assetDomain: 'it', trackingMode: 'individual', serialRequired: true, serialUnique: true })) as { id: string }
      const base = { categoryId: cat.id, modelId: null, manufacturer: 'SmokeCo', modelName: 'S1', specifications: null, condition: 'new', operationalStatus: 'ready', locationId: null, supplierId: null, purchaseDate: null, acquisitionCost: '1000.00', invoiceReference: null, purchaseReference: null, warrantyStart: null, warrantyEnd: null, notes: null }
      const a = (await expectOk('assets.create', { ...base, serialNumber: 'SMK-1' })) as { id: string; assetCode: string; qrPayload: string }
      const dup = await dispatch('assets.create', { ...base, serialNumber: 'smk-1' })
      if (dup.ok || dup.error.code !== 'DUPLICATE_RECORD') throw new Error('duplicate serial was not rejected')
      const labels = (await expectOk('assets.generateLabels', { assetIds: [a.id] })) as Array<{ qrDataUrl: string }>
      if (!labels[0]?.qrDataUrl.startsWith('data:image/svg+xml;base64,')) throw new Error('label artwork missing')
      const found = (await expectOk('assets.lookup', { query: a.qrPayload })) as { matchType: string }
      if (found.matchType !== 'qr') throw new Error('QR lookup failed')
      return `${a.assetCode}; bwip-js loaded; QR lookup ok`
    })
    await check('backup create + validate', async () => {
      const b = (await expectOk('backup.create')) as { backupId: string }
      const v = (await expectOk('backup.validate', { backupId: b.backupId })) as { valid: boolean; problems: string[] }
      if (!v.valid) throw new Error(v.problems.join('; '))
      return b.backupId
    })
  }

  await check('renderer sandbox and bridge', async () => {
    if (win.webContents.isLoading()) await new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()))
    const probe = (await win.webContents.executeJavaScript(
      `({ api: typeof window.api?.session?.login === 'function', require: typeof require, process: typeof process, url: location.origin })`
    )) as { api: boolean; require: string; process: string; url: string }
    if (!probe.api) throw new Error('preload API missing')
    if (probe.require !== 'undefined' || probe.process !== 'undefined') throw new Error('Node globals exposed to renderer')
    return `origin=${probe.url}`
  })

  await check('data persists across reopen', async () => {
    c.dbm.close()
    await c.dbm.open()
    if (c.dbm.status() !== 'ready') throw new Error('organization missing after reopen')
  })

  const ok = checks.every((x) => x.ok)
  writeFileSync(reportPath, JSON.stringify({ ok, appVersion: c.meta.appVersion, dataDirectory: c.paths.root, checks }, null, 2), 'utf8')
  return ok ? 0 : 1
}
