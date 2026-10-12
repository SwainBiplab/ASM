import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { E2E_ADMIN } from './accounts'
import { goTo, signIn, uniq } from './helpers'

/**
 * The minimal "Offline agents" admin UI (device enrollment/trust, exclusive leases, W9.2).
 * `E2E_ADMIN` holds every permission, so one user can play both the device owner and the approving
 * administrator -- the server's own authorization is already covered by `tests/server/w9-*`; this
 * suite only proves the screen actually drives those real commands end to end.
 */

async function rpc<T = { id: string }>(page: Page, command: string, body: unknown): Promise<T> {
  const res = await page.request.post(`/api/v1/rpc/${command}`, { headers: { 'x-bpoam-request': '1', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, data: body })
  const json = (await res.json()) as { ok: boolean; data: T; error?: { message: string } }
  if (!json.ok) throw new Error(`${command}: ${json.error?.message}`)
  return json.data
}

const p = uniq()

test('enrolls a device, an administrator approves it, a lease is requested and released', async ({ page }) => {
  await signIn(page, E2E_ADMIN)
  const category = await rpc(page, 'categories.create', { code: `OA${p.slice(-5).toUpperCase()}`, name: `Offline agent assets ${p}`, description: null, assetDomain: 'it', trackingMode: 'individual', serialRequired: false, serialUnique: false })
  const asset = await rpc<{ id: string; assetCode: string }>(page, 'assets.create', {
    categoryId: category.id, modelId: null, manufacturer: 'Dell', modelName: 'Latitude', serialNumber: `OASN-${p}`, specifications: null, condition: 'good',
    operationalStatus: 'ready', locationId: null, supplierId: null, purchaseDate: null, acquisitionCost: null, invoiceReference: null, purchaseReference: null, warrantyStart: null, warrantyEnd: null, notes: null
  })

  await goTo(page, 'Offline agents')
  const deviceUuid = randomUUID()
  const deviceName = `E2E Field Laptop ${p}`

  await page.getByRole('button', { name: 'Enroll a device' }).click()
  const enrollDialog = page.getByRole('dialog', { name: 'Enroll a device' })
  await enrollDialog.getByLabel('Device ID').fill(deviceUuid)
  await enrollDialog.getByLabel('Device name').fill(deviceName)
  await enrollDialog.getByRole('button', { name: 'Request enrollment' }).click()
  await expect(page.getByText(`"${deviceName}" enrolled`)).toBeVisible()

  const allDevicesPanel = page.locator('.panel', { has: page.getByRole('heading', { name: 'All devices' }) })
  const adminDeviceRow = allDevicesPanel.locator('tr', { hasText: deviceName })
  await expect(adminDeviceRow.getByText('pending')).toBeVisible()
  await adminDeviceRow.getByRole('button', { name: 'Approve' }).click()
  const approveDialog = page.getByRole('dialog', { name: `Approve "${deviceName}"` })
  await approveDialog.getByLabel('Trust notes').fill('Verified managed laptop with full-disk encryption (E2E)')
  await approveDialog.getByRole('button', { name: 'Approve device' }).click()
  await expect(page.getByText(`"${deviceName}" approved`)).toBeVisible()
  await expect(adminDeviceRow.getByText('active')).toBeVisible()

  await page.getByRole('button', { name: 'Request a lease' }).click()
  const leaseDialog = page.getByRole('dialog', { name: 'Request a lease' })
  await leaseDialog.getByLabel('Device').selectOption({ label: deviceName })
  await leaseDialog.getByLabel('Find assets by code, serial, or make/model').fill(asset.assetCode)
  await leaseDialog.getByRole('button', { name: new RegExp(asset.assetCode) }).click()
  await expect(leaseDialog.getByText(asset.assetCode).last()).toBeVisible()
  await leaseDialog.getByRole('button', { name: 'Request lease' }).click()
  await expect(page.getByText(/Lease granted for work package/)).toBeVisible()

  const myLeasesPanel = page.locator('.panel', { has: page.getByRole('heading', { name: 'My leases' }) })
  await expect(myLeasesPanel.getByText('1 asset(s)')).toBeVisible()
  await expect(myLeasesPanel.getByText('active', { exact: true })).toBeVisible()

  await myLeasesPanel.getByRole('button', { name: 'Release' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'released.' })).toBeVisible()
  await expect(myLeasesPanel.getByText('released', { exact: true })).toBeVisible()
})

test('a user without leases.manage/devices.manage/leases.force_reclaim cannot see the module at all', async ({ page }) => {
  await signIn(page, E2E_ADMIN)
  const username = `oaemployee${p}`
  await rpc(page, 'users.create', { username, displayName: 'Offline Agents E2E Employee', password: 'OAEmployee-E2E-1', roleKeys: ['employee'] })
  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.goto('/')
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password').fill('OAEmployee-E2E-1')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Change password' })).toBeVisible()
  await page.getByLabel('Current password').fill('OAEmployee-E2E-1')
  await page.getByLabel('New password', { exact: true }).fill('OAEmployee-E2E-Chosen-9')
  await page.getByLabel('Confirm new password').fill('OAEmployee-E2E-Chosen-9')
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()

  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Offline agents' })).toHaveCount(0)
  const res = await page.request.post('/api/v1/rpc/devices.list', { headers: { 'x-bpoam-request': '1', 'content-type': 'application/json' }, data: { mine: true } })
  const json = (await res.json()) as { ok: boolean; error?: { code: string } }
  expect(json).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
})
