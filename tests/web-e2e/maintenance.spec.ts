import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { E2E_ADMIN, E2E_USERS } from './accounts'
import { goTo, signIn, sql, uniq } from './helpers'

test.describe.configure({ mode: 'serial' })

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

async function rpc<T = { id: string }>(page: Page, command: string, body: unknown): Promise<T> {
  const res = await page.request.post(`/api/v1/rpc/${command}`, { headers: { 'x-bpoam-request': '1', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, data: body })
  const json = (await res.json()) as { ok: boolean; data: T; error?: { message: string } }
  if (!json.ok) throw new Error(`${command}: ${json.error?.message}`)
  return json.data
}

const p = uniq()
const fx = { assets: [] as Array<{ id: string; assetCode: string }> }

test('arrange: a category and two assets', async ({ page }) => {
  await signIn(page, E2E_ADMIN)
  const cat = await rpc(page, 'categories.create', { code: `MT${p.slice(-5).toUpperCase()}`, name: `Printers W5 ${p}`, description: null, assetDomain: 'it', trackingMode: 'individual', serialRequired: false, serialUnique: false })
  for (let i = 0; i < 2; i++) {
    fx.assets.push(await rpc(page, 'assets.create', { categoryId: cat.id, modelId: null, manufacturer: 'HP', modelName: 'LaserJet', serialNumber: `MTSN-${p}-${i}`, specifications: null, condition: 'good', operationalStatus: 'ready', locationId: null, supplierId: null, purchaseDate: null, acquisitionCost: null, invoiceReference: null, purchaseReference: null, warrantyStart: null, warrantyEnd: null, notes: null }))
  }
})

test('reports a fault, works the ticket through to closure, and shows it on the asset page', async ({ page }) => {
  const asset = fx.assets[0]!
  await signIn(page, E2E_ADMIN)
  await goTo(page, 'Maintenance')
  await page.getByRole('button', { name: 'Report a fault' }).click()
  const dialog = page.getByRole('dialog', { name: 'Report a fault' })
  await dialog.getByLabel('Asset').fill(asset.assetCode)
  await dialog.getByLabel('Asset').press('Enter')
  await expect(dialog.getByText(asset.assetCode)).toBeVisible()
  await dialog.getByLabel('Fault category').selectOption({ label: 'Hardware fault' })
  await dialog.getByLabel('Priority').selectOption({ label: 'High' })
  await dialog.getByLabel('Description').fill('Paper jam every few pages')
  await dialog.getByRole('button', { name: 'Open ticket' }).click()
  await expect(page.getByRole('heading', { name: new RegExp(`MT-\\d{6}: ${asset.assetCode}`) })).toBeVisible()
  await expect(page.getByText('Open', { exact: true })).toBeVisible()

  // The asset is flagged under maintenance.
  const [row] = await sql<{ s: string }>('SELECT operational_status AS s FROM assets WHERE id = $1', [asset.id])
  expect(row!.s).toBe('under_maintenance')

  await page.getByRole('button', { name: 'Assign technician' }).click()
  const assignDialog = page.getByRole('dialog', { name: 'Assign technician' })
  await assignDialog.getByLabel('Technician', { exact: true }).selectOption({ label: E2E_ADMIN.displayName })
  await assignDialog.getByRole('button', { name: 'Assign' }).click()
  await expect(page.getByText('In progress')).toBeVisible()

  // Evidence can be attached while the ticket is open.
  await page.getByText('Attach photo or document').click()
  await page.locator('input[type=file]').setInputFiles({ name: 'repair.png', mimeType: 'image/png', buffer: PNG })
  await expect(page.getByText('repair.png')).toBeVisible()

  await page.getByRole('button', { name: 'Mark resolved' }).click()
  const resolve = page.getByRole('dialog', { name: 'Mark resolved' })
  await resolve.getByLabel('Diagnosis').fill('Worn feed roller')
  await resolve.getByLabel('Work performed').fill('Replaced the feed roller')
  await resolve.getByRole('button', { name: 'Mark resolved' }).click()
  await expect(page.getByText('Resolved, pending closure')).toBeVisible()

  await page.getByRole('button', { name: 'Close ticket' }).click()
  const close = page.getByRole('dialog', { name: /^Close MT-\d{6}$/ })
  await close.getByLabel('Asset after closing').selectOption({ label: 'Inspected: ready for reuse' })
  await close.getByLabel('Closing notes').fill('Tested with 50 pages, no further jams')
  await close.getByRole('button', { name: 'Close ticket' }).click()
  await expect(page.getByText('Closed', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/Tested with 50 pages/).first()).toBeVisible()
  const [closedRow] = await sql<{ s: string }>('SELECT operational_status AS s FROM assets WHERE id = $1', [asset.id])
  expect(closedRow!.s).toBe('ready')

  // History is preserved and visible from the asset's own page.
  await page.goto(`/#/assets/${asset.id}`)
  const maintSection = page.getByRole('region', { name: 'Maintenance history' })
  await expect(maintSection).toContainText(/MT-\d{6}/)
  await expect(maintSection.getByText('Closed', { exact: true })).toBeVisible()
})

test('refuses a second open ticket unless justified, and never closes without resolving first', async ({ page }) => {
  const asset = fx.assets[1]!
  await signIn(page, E2E_ADMIN)
  await goTo(page, 'Maintenance')
  await page.getByRole('button', { name: 'Report a fault' }).click()
  let dialog = page.getByRole('dialog', { name: 'Report a fault' })
  await dialog.getByLabel('Asset').fill(asset.assetCode)
  await dialog.getByLabel('Asset').press('Enter')
  await dialog.getByLabel('Description').fill('Display is dim')
  await dialog.getByRole('button', { name: 'Open ticket' }).click()
  await expect(page.getByRole('heading', { name: new RegExp(asset.assetCode) })).toBeVisible()

  await goTo(page, 'Maintenance')
  await page.getByRole('button', { name: 'Report a fault' }).click()
  dialog = page.getByRole('dialog', { name: 'Report a fault' })
  await dialog.getByLabel('Asset').fill(asset.assetCode)
  await dialog.getByLabel('Asset').press('Enter')
  await dialog.getByLabel('Description').fill('Unrelated keyboard fault')
  await dialog.getByRole('button', { name: 'Open ticket' }).click()
  await expect(dialog.getByText(/already has an open ticket/).first()).toBeVisible()
  await dialog.getByLabel('Open an additional ticket anyway').check()
  await dialog.getByLabel('Justification').fill('Separate fault reported independently')
  await dialog.getByRole('button', { name: 'Open ticket' }).click()
  await expect(page.getByRole('heading', { name: new RegExp(asset.assetCode) })).toBeVisible()
  expect(await sql('SELECT 1 FROM maintenance_tickets WHERE asset_id = $1 AND status = $2', [asset.id, 'open'])).toHaveLength(2)

  // Closing requires resolving first; the UI does not even offer "Close" before "Mark resolved".
  await expect(page.getByRole('button', { name: 'Close ticket' })).toHaveCount(0)
})

test('HR cannot see the Maintenance module or call its API', async ({ page }) => {
  await signIn(page, E2E_USERS.hr)
  const nav = page.getByRole('navigation', { name: 'Main' })
  await expect(nav.getByRole('link', { name: 'Maintenance', exact: true })).toHaveCount(0)
  await page.goto('/#/maintenance')
  await expect(page.getByRole('heading', { name: 'Maintenance', exact: true })).toHaveCount(0)
  const denied = await page.request.post('/api/v1/rpc/maintenance.list', { headers: { 'x-bpoam-request': '1', 'content-type': 'application/json' }, data: { status: 'all' } })
  expect(denied.status()).toBe(403)
})
