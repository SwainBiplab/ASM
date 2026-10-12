/// <reference lib="dom" />
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

let app: ElectronApplication
let page: Page
let dataDir: string

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  return { ...env, ...extra }
}

async function launch(): Promise<void> {
  app = await electron.launch({ args: ['.'], env: cleanEnv({ BPOAM_DATA_DIR: dataDir, BPOAM_ENV: 'test' }) })
  page = await app.firstWindow()
}

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'bpoam-e2e-'))
  await launch()
})

test.afterAll(async () => {
  await app?.close()
  rmSync(dataDir, { recursive: true, force: true })
})

test('renderer is sandboxed and only sees the preload API', async () => {
  const probe = await page.evaluate(() => ({
    api: typeof (window as unknown as { api?: { session?: { login?: unknown } } }).api?.session?.login,
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    origin: location.origin
  }))
  expect(probe).toEqual({ api: 'function', require: 'undefined', process: 'undefined', origin: 'app://bundle' })
})

test('first-run setup, sign-in, backup and restart persistence', async () => {
  await expect(page.getByRole('heading', { name: 'Initial setup' })).toBeVisible()
  await page.getByLabel('Legal name').fill('E2E BPO Pvt Ltd')
  await page.getByLabel('Display name').fill('E2E BPO')
  await page.getByLabel('Time zone').fill('Asia/Kolkata')
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Full name').fill('E2E Admin')
  await page.getByLabel('Password', { exact: true }).fill('E2E-Password-1')
  await page.getByLabel('Confirm password').fill('E2E-Password-1')
  await page.getByRole('button', { name: 'Create organization and Super Admin' }).click()

  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password').fill('wrong-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toContainText('Invalid username or password')

  await page.getByLabel('Password').fill('E2E-Password-1')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'E2E BPO' })).toBeVisible()
  await expect(page.getByText('No backup has been made yet.')).toBeVisible()

  await page.getByRole('link', { name: 'Backup and recovery' }).click()
  await page.getByRole('button', { name: 'Back up now' }).click()
  await expect(page.getByText('Backup created and verified')).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Verified' })).toBeVisible()
  await page.screenshot({ path: 'test-results/backup-page.png' })

  await page.getByRole('link', { name: 'Audit log' }).click()
  await expect(page.getByRole('cell', { name: 'backup.created' })).toBeVisible()

  await app.close()
  await launch()
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password').fill('E2E-Password-1')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'E2E BPO' })).toBeVisible()
  await page.screenshot({ path: 'test-results/dashboard.png' })
})

// Runs last: the blocked navigation leaves Playwright waiting on a navigation that never commits.
test('blocks navigation to remote content', async () => {
  await page.evaluate(() => {
    window.location.href = 'https://example.com/'
  })
  await page.waitForTimeout(500)
  expect(page.url()).toContain('app://bundle')
})
