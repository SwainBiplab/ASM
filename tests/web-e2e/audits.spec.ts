import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { E2E_ADMIN, E2E_USERS } from './accounts'
import { goTo, signIn, sql, uniq } from './helpers'

test.describe.configure({ mode: 'serial' })

async function rpc<T = { id: string }>(page: Page, command: string, body: unknown): Promise<T> {
  const res = await page.request.post(`/api/v1/rpc/${command}`, { headers: { 'x-bpoam-request': '1', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, data: body })
  const json = (await res.json()) as { ok: boolean; data: T; error?: { message: string } }
  if (!json.ok) throw new Error(`${command}: ${json.error?.message}`)
  return json.data
}

const p = uniq()
const fx = { locationId: '', storeId: '', assets: [] as Array<{ id: string; assetCode: string }> }

test('arrange: a location, a storeroom and three assets', async ({ page }) => {
  await signIn(page, E2E_ADMIN)
  const cat = await rpc(page, 'categories.create', { code: `AU${p.slice(-5).toUpperCase()}`, name: `Audit kit W5 ${p}`, description: null, assetDomain: 'it', trackingMode: 'individual', serialRequired: false, serialUnique: false })
  const site = await rpc(page, 'locations.create', { locationType: 'site', name: `Audit Site ${p}`, code: null, parentLocationId: null, notes: null })
  fx.locationId = site.id
  const store = await rpc(page, 'locations.create', { locationType: 'storage', name: `Audit Store ${p}`, code: null, parentLocationId: site.id, notes: null })
  fx.storeId = store.id
  for (let i = 0; i < 3; i++) {
    fx.assets.push(await rpc(page, 'assets.create', { categoryId: cat.id, modelId: null, manufacturer: 'Dell', modelName: 'OptiPlex', serialNumber: `AUSN-${p}-${i}`, specifications: null, condition: 'good', operationalStatus: 'ready', locationId: site.id, supplierId: null, purchaseDate: null, acquisitionCost: null, invoiceReference: null, purchaseReference: null, warrantyStart: null, warrantyEnd: null, notes: null }))
  }
})

test('opens an audit by location, verifies, flags, resolves, and closes with an accepted exception', async ({ page }) => {
  const [matching, moved, missing] = fx.assets
  await signIn(page, E2E_ADMIN)
  await goTo(page, 'Physical audits')
  await page.getByRole('button', { name: 'New audit' }).click()
  const createDialog = page.getByRole('dialog', { name: 'New physical audit' })
  await createDialog.getByLabel('Title').fill(`Site sweep ${p}`)
  await createDialog.getByLabel('Scope by').selectOption({ label: 'Location' })
  await createDialog.getByLabel('Location').selectOption({ label: `Audit Site ${p}` })
  await createDialog.getByRole('button', { name: 'Open audit' }).click()
  await expect(page.getByRole('heading', { name: new RegExp(`AUD-\\d{6}: Site sweep ${p}`) })).toBeVisible()
  const items = page.getByTestId('audit-item')
  await expect(items).toHaveCount(3)
  await expect(page.getByRole('button', { name: 'Close audit' })).toBeDisabled()

  // A matching scan confirms the prefilled (current) location and condition, unedited.
  await page.getByLabel('Asset code, serial or QR').fill(matching!.assetCode)
  await page.getByLabel('Asset code, serial or QR').press('Enter')
  const confirmMatching = page.getByRole('dialog', { name: `Confirm observation: ${matching!.assetCode}` })
  await expect(confirmMatching.getByLabel('Observed condition')).toHaveValue('good')
  await confirmMatching.getByRole('button', { name: 'Record' }).click()
  const matchingRow = items.filter({ hasText: matching!.assetCode })
  await expect(matchingRow).toContainText('Verified')

  // Scanning an asset that was physically moved: the operator corrects the observed location.
  await page.getByLabel('Asset code, serial or QR').fill(moved!.assetCode)
  await page.getByLabel('Asset code, serial or QR').press('Enter')
  const confirmMoved = page.getByRole('dialog', { name: `Confirm observation: ${moved!.assetCode}` })
  await confirmMoved.getByLabel('Observed location').selectOption({ label: `Audit Site ${p} / Audit Store ${p}` })
  await confirmMoved.getByLabel('Notes').fill('Found in the storeroom')
  await confirmMoved.getByRole('button', { name: 'Record' }).click()
  const movedRow = items.filter({ hasText: moved!.assetCode })
  await expect(movedRow).toContainText('Discrepancy')
  await expect(movedRow).toContainText('Wrong location')

  await movedRow.getByRole('button', { name: 'Correct location' }).click()
  const correctDialog = page.getByRole('dialog', { name: `Correct location for ${moved!.assetCode}` })
  await correctDialog.getByLabel('Correct location').selectOption({ label: `Audit Site ${p} / Audit Store ${p}` })
  await correctDialog.getByLabel('Reason').fill('Confirmed moved during last reorganization')
  await correctDialog.getByRole('button', { name: 'Update master record' }).click()
  await expect(movedRow).toContainText('Resolved')
  const [assetRow] = await sql<{ locationId: string }>('SELECT location_id AS "locationId" FROM assets WHERE id = $1', [moved!.id])
  expect(assetRow!.locationId).toBe(fx.storeId)

  const missingRow = items.filter({ hasText: missing!.assetCode })
  await missingRow.getByRole('button', { name: 'Mark missing' }).click()
  const missingDialog = page.getByRole('dialog', { name: `Mark ${missing!.assetCode} missing` })
  await missingDialog.getByLabel('Notes').fill('Not found in two searches of the site')
  await missingDialog.getByRole('button', { name: 'Mark missing' }).click()
  await expect(missingRow).toContainText('Discrepancy')
  await expect(page.getByRole('button', { name: 'Close audit' })).toBeDisabled()

  await missingRow.getByRole('button', { name: 'Accept exception' }).click()
  const acceptDialog = page.getByRole('dialog', { name: `Accept exception for ${missing!.assetCode}` })
  await acceptDialog.getByLabel('Decision notes').fill('Accepted pending a separate loss investigation')
  await acceptDialog.getByRole('button', { name: 'Accept exception' }).click()
  await expect(missingRow).toContainText('Accepted exception')
  // Never automatically marked lost.
  const [missingStatus] = await sql<{ status: string }>('SELECT lifecycle_status AS status FROM assets WHERE id = $1', [missing!.id])
  expect(missingStatus!.status).toBe('active')

  await page.getByRole('button', { name: 'Close audit' }).click()
  await page.getByRole('dialog', { name: 'Close audit' }).getByRole('button', { name: 'Close audit' }).click()
  await expect(page.getByText(/Closed with accepted exceptions/)).toBeVisible()
  await page.reload()
  await expect(page.getByText(/Closed with accepted exceptions/)).toBeVisible()
  const [x] = await sql<{ status: string; closure_type: string }>("SELECT status, closure_type FROM physical_audits WHERE title = $1", [`Site sweep ${p}`])
  expect(x).toEqual({ status: 'closed', closure_type: 'with_exceptions' })
})

test('an edit to a verified asset after the audit opened does not change the frozen expected baseline', async ({ page }) => {
  const asset = fx.assets[0]!
  await signIn(page, E2E_ADMIN)
  const x = await rpc(page, 'audits.create', { title: `Baseline check ${p}`, scope: { locationId: null, categoryId: null, custodianEmployeeId: null, assetIds: [asset.id] }, responsibleUserId: null, notes: null })
  await sql('UPDATE assets SET condition = $2 WHERE id = $1', [asset.id, 'damaged'])
  await page.goto(`/#/audits/${x.id}`)
  await expect(page.getByTestId('audit-item')).toContainText('good')
})

test('HR cannot see the module at all; an asset manager can scan but not close', async ({ page, browser }) => {
  const [x] = await sql<{ id: string }>("SELECT id FROM physical_audits WHERE title = $1", [`Baseline check ${p}`])
  await signIn(page, E2E_USERS.hr)
  const nav = page.getByRole('navigation', { name: 'Main' })
  await expect(nav.getByRole('link', { name: 'Physical audits', exact: true })).toHaveCount(0)
  const denied = await page.request.post('/api/v1/rpc/audits.list', { headers: { 'x-bpoam-request': '1', 'content-type': 'application/json' }, data: { status: 'all' } })
  expect(denied.status()).toBe(403)

  const mgrContext = await browser.newContext()
  const mgrPage = await mgrContext.newPage()
  await signIn(mgrPage, E2E_USERS.assetManager)
  await mgrPage.goto(`/#/audits/${x!.id}`)
  await expect(mgrPage.getByLabel('Asset code, serial or QR')).toBeVisible()
  const verifyDenied = await mgrPage.request.post('/api/v1/rpc/audits.close', { headers: { 'x-bpoam-request': '1', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, data: { auditId: x!.id, closingNotes: null } })
  expect(verifyDenied.status()).toBe(403)
  await mgrContext.close()
})
