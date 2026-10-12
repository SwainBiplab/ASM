import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { E2E_ADMIN, E2E_USERS } from './accounts'
import { goTo, signIn, uniq } from './helpers'

test.describe.configure({ mode: 'serial' })

async function rpc<T = { id: string }>(page: Page, command: string, body: unknown): Promise<T> {
  const res = await page.request.post(`/api/v1/rpc/${command}`, { headers: { 'x-bpoam-request': '1', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, data: body })
  const json = (await res.json()) as { ok: boolean; data: T; error?: { message: string } }
  if (!json.ok) throw new Error(`${command}: ${json.error?.message}`)
  return json.data
}

const p = uniq()

test('arrange: a category and an asset with a known acquisition cost', async ({ page }) => {
  await signIn(page, E2E_ADMIN)
  await rpc(page, 'categories.create', { code: `RP${p.slice(-4).toUpperCase()}`, name: `Report Laptops ${p}`, description: null, assetDomain: 'it', trackingMode: 'individual', serialRequired: false, serialUnique: false })
})

test('admin sees asset valuation totals by currency and exports a CSV', async ({ page }) => {
  await signIn(page, E2E_ADMIN)
  const cats = await rpc<Array<{ id: string; name: string }>>(page, 'categories.list', { includeInactive: false })
  const category = cats.find((c) => c.name === `Report Laptops ${p}`)!
  await rpc(page, 'assets.create', {
    categoryId: category.id, modelId: null, manufacturer: 'Dell', modelName: 'Latitude', serialNumber: `RP-${p}`, specifications: null, condition: 'good', operationalStatus: 'ready',
    locationId: null, supplierId: null, purchaseDate: '2026-02-01', acquisitionCost: '75000.00', invoiceReference: null, purchaseReference: null, warrantyStart: null, warrantyEnd: null, notes: null
  })

  await goTo(page, 'Reports')
  await expect(page.getByRole('tab', { name: 'Asset valuation' })).toBeVisible()
  await page.getByLabel('Category').selectOption({ label: `Report Laptops ${p}` })
  await expect(page.getByText(/Acquisition value INR 75,000\.00/)).toBeVisible()
  await expect(page.getByRole('cell', { name: `Report Laptops ${p}` })).toBeVisible()

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()])
  expect(download.suggestedFilename()).toMatch(/^asset-valuation-\d{4}-\d{2}-\d{2}\.csv$/)
})

test('HR sees the report without acquisition cost, since HR lacks finance.view_cost', async ({ page }) => {
  await signIn(page, E2E_USERS.hr)
  await goTo(page, 'Reports')
  await expect(page.getByText('Acquisition cost is hidden')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Export CSV' })).toHaveCount(0)
})

test('an employee-only role cannot see or call the Reports module', async ({ page }) => {
  await signIn(page, E2E_ADMIN)
  const username = `noreports${p}`
  await rpc(page, 'users.create', { username, displayName: `No Reports ${p}`, password: 'NoReports-E2E-1', roleKeys: ['employee'] })
  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.goto('/')
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password').fill('NoReports-E2E-1')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Change password' })).toBeVisible()
  await page.getByLabel('Current password').fill('NoReports-E2E-1')
  await page.getByLabel('New password', { exact: true }).fill('NoReports-E2E-Chosen-9')
  await page.getByLabel('Confirm new password').fill('NoReports-E2E-Chosen-9')
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()

  const nav = page.getByRole('navigation', { name: 'Main' })
  await expect(nav.getByRole('link', { name: 'Reports', exact: true })).toHaveCount(0)
  await page.goto('/#/reports')
  await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toHaveCount(0)
  const denied = await page.request.post('/api/v1/rpc/reports.assetValuation', { headers: { 'x-bpoam-request': '1', 'content-type': 'application/json' }, data: { lifecycle: 'all' } })
  expect(denied.status()).toBe(403)
})
