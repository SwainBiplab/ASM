/// <reference lib="dom" />
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

let app: ElectronApplication
let page: Page
let dataDir: string

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'bpoam-e2e-org-'))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  app = await electron.launch({ args: ['.'], env: { ...env, BPOAM_DATA_DIR: join(dataDir, 'data'), BPOAM_ENV: 'test' } })
  page = await app.firstWindow()

  await page.getByLabel('Legal name').fill('Org E2E Pvt Ltd')
  await page.getByLabel('Display name').fill('Org E2E')
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
  await expect(page.getByRole('heading', { name: 'Org E2E' })).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  rmSync(dataDir, { recursive: true, force: true })
})

test('builds departments, teams and a location hierarchy', async () => {
  await page.getByRole('link', { name: 'Departments and locations' }).click()
  await page.getByRole('button', { name: 'Add department' }).click()
  const dlg = page.getByRole('dialog')
  await dlg.getByLabel('Name').fill('Operations')
  await dlg.getByLabel('Code').fill('OPS')
  await dlg.getByRole('button', { name: 'Add department' }).click()
  await expect(page.getByRole('heading', { name: 'Operations', level: 2 })).toBeVisible()

  await page.getByRole('button', { name: 'Add team' }).click()
  await page.getByRole('dialog').getByLabel('Name').fill('Voice Support')
  await page.getByRole('dialog').getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByText('Voice Support')).toBeVisible()

  await page.getByRole('tab', { name: 'Locations' }).click()
  await page.getByRole('button', { name: 'Add office / site' }).click()
  await page.getByRole('dialog').getByLabel('Name').fill('Pune Campus')
  await page.getByRole('dialog').getByLabel('Code').fill('PUN')
  await page.getByRole('dialog').getByRole('button', { name: 'Add location' }).click()
  await page.getByRole('row', { name: /Pune Campus/ }).getByRole('button', { name: 'Add inside' }).click()
  await expect(page.getByRole('dialog').getByLabel('Type')).toHaveValue('building')
  await page.getByRole('dialog').getByLabel('Name').fill('Tower B')
  await page.getByRole('dialog').getByRole('button', { name: 'Add location' }).click()
  await expect(page.getByRole('cell', { name: 'Tower B' })).toBeVisible()
})

test('imports employees from CSV with row-level review, then shows them', async () => {
  const csv = join(dataDir, 'employees.csv')
  writeFileSync(
    csv,
    ['Employee ID,Full Name,Department,Team,Manager ID,Location', 'E001,Asha Menon,OPS,,,PUN', 'E002,"Kumar, Ravi",Operations,Voice Support,E001,PUN', 'E003,,Operations,,,'].join('\r\n'),
    'utf8'
  )
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog
  }, csv)

  await page.getByRole('link', { name: 'Employees' }).click()
  await page.getByRole('button', { name: 'Import CSV' }).click()
  await page.getByRole('button', { name: 'Choose CSV file' }).click()
  await expect(page.getByLabel('Import summary')).toContainText('2Accepted')
  await expect(page.getByLabel('Import summary')).toContainText('1Rejected')
  await expect(page.getByText('Full name is required.')).toBeVisible()

  const importButton = page.getByRole('button', { name: 'Import 2 employees' })
  await expect(importButton).toBeDisabled()
  await page.getByLabel(/Skip the 1 rejected/).check()
  await importButton.click()
  await expect(page.getByText('2 employees imported.')).toBeVisible()
  await page.screenshot({ path: 'test-results/import-done.png' })

  await page.getByRole('button', { name: 'View employees' }).click()
  await expect(page.getByRole('cell', { name: 'E002' })).toBeVisible()
  await page.getByRole('button', { name: 'Kumar, Ravi' }).click()
  await expect(page.locator('dd').getByRole('button', { name: 'Asha Menon' })).toBeVisible()
  await page.screenshot({ path: 'test-results/employees.png' })
})
