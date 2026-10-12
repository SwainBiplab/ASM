/// <reference lib="dom" />
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

let app: ElectronApplication
let page: Page
let dataDir: string

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'bpoam-e2e-assets-'))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  app = await electron.launch({ args: ['.'], env: { ...env, BPOAM_DATA_DIR: join(dataDir, 'data'), BPOAM_ENV: 'test' } })
  page = await app.firstWindow()
  await page.getByLabel('Legal name').fill('Asset E2E Pvt Ltd')
  await page.getByLabel('Display name').fill('Asset E2E')
  await page.getByLabel('Time zone').fill('Asia/Kolkata')
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Full name').fill('Admin')
  await page.getByLabel('Password', { exact: true }).fill('E2E-Password-1')
  await page.getByLabel('Confirm password').fill('E2E-Password-1')
  await page.getByRole('button', { name: 'Create organization and Super Admin' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password').fill('E2E-Password-1')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Asset E2E' })).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  rmSync(dataDir, { recursive: true, force: true })
})

test('registers an asset with an automatic AST code', async () => {
  await page.getByRole('link', { name: 'Asset catalogue' }).click()
  await page.getByRole('button', { name: 'Add category' }).click()
  const dlg = page.getByRole('dialog')
  await dlg.getByLabel('Name').fill('Laptop')
  await dlg.getByLabel('Code').fill('LAP')
  await dlg.getByLabel('Serial numbers').selectOption('unique')
  await dlg.getByRole('button', { name: 'Add category' }).click()
  await expect(page.getByRole('cell', { name: 'Required, unique' })).toBeVisible()

  await page.getByRole('link', { name: 'Assets', exact: true }).click()
  await page.getByRole('button', { name: 'Add asset' }).click()
  const form = page.getByRole('dialog')
  await form.getByLabel('Manufacturer').fill('Dell')
  await form.getByLabel('Model name').fill('Latitude 5440')
  await form.getByLabel(/Serial number/).fill('DL-778899')
  await form.getByLabel('Acquisition cost').fill('64,990.00')
  await form.getByRole('button', { name: 'Register asset' }).click()
  await expect(page.getByText('AST-000001 was registered.')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'AST-000001' })).toBeVisible()
  await expect(page.getByText('INR 64,990.00')).toBeVisible()
})

test('finds the asset by scanning its code and attaches a document', async () => {
  await page.getByRole('link', { name: 'Scan / find asset' }).click()
  const scan = page.getByLabel('Asset code, serial number or QR label')
  await expect(scan).toBeFocused()
  // A keyboard-wedge scanner types the code followed by Enter.
  await scan.pressSequentially('ast-000001')
  await scan.press('Enter')
  await expect(page.getByText('Found AST-000001.')).toBeVisible()
  await expect(scan).toBeFocused()
  await scan.pressSequentially('NOT-A-CODE')
  await scan.press('Enter')
  await expect(page.getByText('No asset has the code or serial number "NOT-A-CODE".')).toBeVisible()

  await scan.pressSequentially('dl-778899')
  await scan.press('Enter')
  await page.getByRole('button', { name: 'Open asset' }).click()
  await expect(page.getByRole('heading', { name: 'AST-000001' })).toBeVisible()

  const pdf = join(dataDir, 'invoice.pdf')
  writeFileSync(pdf, '%PDF-1.4\n% e2e invoice\n%%EOF\n')
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog
  }, pdf)
  await page.getByRole('button', { name: 'Attach file' }).click()
  await expect(page.getByText('invoice.pdf')).toBeVisible()
  await expect(page.getByText('Documents (1)')).toBeVisible()
})

test('shows printable QR and barcode labels', async () => {
  await page.getByRole('button', { name: 'Print label' }).click()
  const labels = page.getByRole('dialog', { name: 'Asset labels' })
  await expect(labels.getByAltText('QR code for AST-000001')).toBeVisible()
  await expect(labels.getByAltText('Barcode for AST-000001')).toBeVisible()
  await page.screenshot({ path: 'test-results/labels.png' })
  await labels.getByRole('button', { name: 'Close' }).click()
  await page.screenshot({ path: 'test-results/asset-detail.png' })
})
