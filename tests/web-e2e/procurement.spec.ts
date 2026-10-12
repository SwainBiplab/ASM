import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { E2E_ADMIN } from './accounts'
import { goTo, signIn, sql, uniq } from './helpers'

test.describe.configure({ mode: 'serial' })

async function rpc<T = { id: string }>(page: Page, command: string, body: unknown): Promise<T> {
  const res = await page.request.post(`/api/v1/rpc/${command}`, { headers: { 'x-bpoam-request': '1', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, data: body })
  const json = (await res.json()) as { ok: boolean; data: T; error?: { message: string } }
  if (!json.ok) throw new Error(`${command}: ${json.error?.message}`)
  return json.data
}

const p = uniq()
const buyer = { username: `buyer${p}`, displayName: `Buyer ${p}`, password: 'Buyer-E2E-Pass-1' }
const fx: { requestNumber?: string; poNumber?: string } = {}

test('arrange: a category, location, supplier, and a procurement officer account', async ({ page }) => {
  await signIn(page, E2E_ADMIN)
  await rpc(page, 'categories.create', { code: `PR${p.slice(-5).toUpperCase()}`, name: `Monitors W6 ${p}`, description: null, assetDomain: 'it', trackingMode: 'individual', serialRequired: true, serialUnique: true })
  await rpc(page, 'locations.create', { locationType: 'site', name: `W6 Site ${p}`, code: null, parentLocationId: null, notes: null })
  await rpc(page, 'suppliers.create', { code: null, name: `W6 Supplier ${p}`, contactName: null, email: null, phone: null, address: null, taxReference: null, notes: null })
  await rpc(page, 'users.create', { username: buyer.username, displayName: buyer.displayName, password: buyer.password, roleKeys: ['procurement_officer'] })

  // First sign-in forces a password change; do it once here so later tests can use signIn() normally.
  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.goto('/')
  await page.getByLabel('Username').fill(buyer.username)
  await page.getByLabel('Password').fill(buyer.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Change password' })).toBeVisible()
  await page.getByLabel('Current password').fill(buyer.password)
  const chosen = 'Buyer-E2E-Chosen-9'
  await page.getByLabel('New password', { exact: true }).fill(chosen)
  await page.getByLabel('Confirm new password').fill(chosen)
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
  buyer.password = chosen
})

test('admin configures an approval policy', async ({ page }) => {
  await signIn(page, E2E_ADMIN)
  await goTo(page, 'Approvals')
  await page.getByRole('tab', { name: 'Approval policies' }).click()
  await page.getByRole('button', { name: 'New policy' }).click()
  const dialog = page.getByRole('dialog', { name: 'New approval policy' })
  await dialog.getByLabel('Policy name').fill(`Standard PR ${p}`)
  await dialog.getByLabel('Step 1: role').selectOption({ label: 'Super Admin' })
  await dialog.getByRole('button', { name: 'Save policy' }).click()
  await expect(page.getByText(`Standard PR ${p}`)).toBeVisible()
})

test('buyer drafts and submits a purchase request', async ({ page }) => {
  await signIn(page, buyer)
  await goTo(page, 'Purchase requests')
  await page.getByRole('button', { name: 'New request' }).click()
  const dialog = page.getByRole('dialog', { name: 'New purchase request' })
  await dialog.getByLabel('Business justification').fill('Replacement monitors for the support floor')
  await dialog.getByLabel('Description').fill('24-inch monitor')
  await dialog.getByLabel('Category').selectOption({ label: `Monitors W6 ${p}` })
  await dialog.getByLabel('Quantity').fill('2')
  await dialog.getByLabel(/Estimated unit cost/).fill('9000')
  await dialog.getByRole('button', { name: 'Save draft' }).click()
  const heading = page.getByRole('heading', { name: /^PR-\d{6}/ })
  await expect(heading).toBeVisible()
  fx.requestNumber = (await heading.textContent())!.trim()
  await page.getByRole('button', { name: 'Submit for approval' }).click()
  await expect(page.getByText('Submitted, pending approval')).toBeVisible()
})

test('admin approves the request from the queue', async ({ page }) => {
  await signIn(page, E2E_ADMIN)
  await goTo(page, 'Approvals')
  await expect(page.getByRole('cell', { name: fx.requestNumber! })).toBeVisible()
  await page.getByRole('button', { name: 'Decide' }).click()
  const dialog = page.getByRole('dialog', { name: `Decide on ${fx.requestNumber}` })
  await dialog.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByText('Nothing is waiting for your decision.')).toBeVisible()
  const [row] = await sql<{ status: string }>('SELECT status FROM purchase_requests WHERE request_number = $1', [fx.requestNumber])
  expect(row!.status).toBe('approved')
})

test('buyer creates a purchase order against the approved request', async ({ page }) => {
  await signIn(page, buyer)
  await goTo(page, 'Purchase orders')
  await page.getByRole('button', { name: 'New order' }).click()
  const dialog = page.getByRole('dialog', { name: 'New purchase order' })
  await dialog.getByLabel('Approved request').selectOption({ label: `${fx.requestNumber} — Replacement monitors for the support floor` })
  await dialog.getByLabel('Supplier').selectOption({ label: `W6 Supplier ${p}` })
  await dialog.getByRole('button', { name: 'Create order' }).click()
  const heading = page.getByRole('heading', { name: /^PO-\d{6}/ })
  await expect(heading).toBeVisible()
  fx.poNumber = (await heading.textContent())!.trim().split(' ')[0]!
})

test('buyer receives the order and the accepted unit becomes a registered, ready asset', async ({ page }) => {
  await signIn(page, buyer)
  await goTo(page, 'Goods receipt')
  await page.getByRole('button', { name: 'Record a receipt' }).click()
  const dialog = page.getByRole('dialog', { name: 'Record a goods receipt' })
  await dialog.getByLabel('Purchase order').selectOption({ label: `${fx.poNumber} — W6 Supplier ${p}` })
  await dialog.getByLabel('Received into location').selectOption({ label: `W6 Site ${p}` })
  await dialog.getByRole('button', { name: 'Add received unit' }).click()
  await dialog.getByLabel(/Unit 1 serial/).fill(`W6-SN-${p}`)
  await dialog.getByRole('button', { name: 'Record receipt' }).click()
  await expect(page.getByRole('heading', { name: /^GR-\d{6}/ })).toBeVisible()
  await expect(page.getByText(`W6-SN-${p}`)).toBeVisible()

  const [asset] = await sql<{ status: string; code: string }>('SELECT operational_status AS status, asset_code AS code FROM assets WHERE serial_number = $1', [`W6-SN-${p}`])
  expect(asset).toMatchObject({ status: 'ready' })
  await expect(page.getByText(asset!.code)).toBeVisible()
})
