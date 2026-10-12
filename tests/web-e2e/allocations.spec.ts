import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { E2E_ADMIN, E2E_USERS } from './accounts'
import { goTo, signIn, sql, uniq } from './helpers'

test.describe.configure({ mode: 'serial' })

const PDF = Buffer.from('%PDF-1.4\n% signed handover receipt\n%%EOF\n', 'latin1')

/** Arranges data through the real API with the browser's session (the workflows themselves run in the UI). */
async function rpc<T = { id: string }>(page: Page, command: string, body: unknown): Promise<T> {
  const res = await page.request.post(`/api/v1/rpc/${command}`, { headers: { 'x-bpoam-request': '1', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, data: body })
  const json = (await res.json()) as { ok: boolean; data: T; error?: { message: string } }
  if (!json.ok) throw new Error(`${command}: ${json.error?.message}`)
  return json.data
}

const p = uniq()
const fx = { employee: { id: '', code: `W4E-${p}`, name: `Ravi W4 ${p}` }, leaver: { id: '', code: `W4L-${p}`, name: `Leaving Person ${p}` }, pool: `Spares ${p}`, assets: [] as Array<{ id: string; assetCode: string }> }

async function pickEmployee(page: Page, scope: ReturnType<Page['getByRole']>, label: string, code: string, name: string) {
  const input = scope.getByLabel(label, { exact: true })
  await input.fill(code)
  await page.waitForTimeout(500) // the picker searches the server as the user types
  await input.fill(`${code} — ${name}`)
}

test('arrange: catalogue, assets, employees and a pool', async ({ page }) => {
  await signIn(page, E2E_ADMIN)
  const cat = await rpc(page, 'categories.create', { code: `W4${p.slice(-5).toUpperCase()}`, name: `Laptops W4 ${p}`, description: null, assetDomain: 'it', trackingMode: 'individual', serialRequired: false, serialUnique: false })
  for (let i = 0; i < 5; i++) {
    fx.assets.push(await rpc(page, 'assets.create', { categoryId: cat.id, modelId: null, manufacturer: 'Lenovo', modelName: 'T14', serialNumber: `W4SN-${p}-${i}`, specifications: null, condition: 'good', operationalStatus: 'ready', locationId: null, supplierId: null, purchaseDate: null, acquisitionCost: null, invoiceReference: null, purchaseReference: null, warrantyStart: null, warrantyEnd: null, notes: null }))
  }
  const emp = (code: string, fullName: string) => ({ employeeCode: code, fullName, email: null, phone: null, jobTitle: null, departmentId: null, teamId: null, managerEmployeeId: null, workLocationId: null, employmentStatus: 'active', joiningDate: null, expectedExitDate: null, notes: null })
  fx.employee.id = (await rpc(page, 'employees.create', emp(fx.employee.code, fx.employee.name))).id
  fx.leaver.id = (await rpc(page, 'employees.create', emp(fx.leaver.code, fx.leaver.name))).id
  const dept = await rpc(page, 'departments.create', { code: null, name: `W4 Ops ${p}`, managerEmployeeId: null, notes: null })
  await rpc(page, 'pools.create', { code: null, name: fx.pool, purpose: null, responsibleDepartmentId: dept.id, responsibleTeamId: null, defaultLocationId: null })
})

test('issues an asset to an employee with on-screen acknowledgment and a printable receipt', async ({ page }) => {
  const asset = fx.assets[0]!
  await signIn(page, E2E_ADMIN)
  await goTo(page, 'Allocations and returns')
  await page.getByRole('button', { name: 'Issue assets' }).click()
  const dialog = page.getByRole('dialog', { name: 'Issue assets' })
  await pickEmployee(page, dialog, 'Employee', fx.employee.code, fx.employee.name)
  const add = dialog.getByLabel('Add asset (code, serial or scan)')
  await add.fill(asset.assetCode)
  await add.press('Enter')
  await expect(dialog.getByTestId('handover-line')).toHaveCount(1)
  // The default policy requires the recipient's on-screen confirmation.
  await dialog.getByRole('button', { name: 'Issue' }).click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await dialog.getByLabel(/confirmed receipt on this screen/).check()
  await dialog.getByLabel('Confirmed by (name)').fill(fx.employee.name)
  await dialog.getByRole('button', { name: 'Issue' }).click()

  const receipt = page.getByRole('dialog', { name: /Asset issue receipt HO-\d{6}/ })
  await expect(receipt).toBeVisible()
  await expect(receipt.getByText(asset.assetCode)).toBeVisible()
  await expect(receipt.getByText(new RegExp(`Acknowledged.*by ${fx.employee.name}`))).toBeVisible()
  await expect(receipt.getByRole('button', { name: 'Print' })).toBeEnabled()
  await receipt.getByRole('button', { name: 'Close' }).click()

  // Persisted: the row survives a reload and the database holds exactly one active assignment.
  await page.reload()
  await page.getByLabel('Search').fill(asset.assetCode)
  await expect(page.getByRole('row').filter({ hasText: asset.assetCode })).toContainText(fx.employee.name)
  const rows = await sql<{ status: string; ack: string }>('SELECT s.status, h.ack_status AS ack FROM asset_assignments s JOIN handovers h ON h.id = s.issue_handover_id WHERE s.asset_id = $1', [asset.id])
  expect(rows).toEqual([{ status: 'active', ack: 'acknowledged' }])
})

test('shows a clear conflict when someone else issued the asset first', async ({ page }) => {
  const asset = fx.assets[1]!
  await signIn(page, E2E_ADMIN)
  await goTo(page, 'Allocations and returns')
  await page.getByRole('button', { name: 'Issue assets' }).click()
  const dialog = page.getByRole('dialog', { name: 'Issue assets' })
  await dialog.getByLabel('Assign to').selectOption({ label: 'Shared pool' })
  await dialog.getByLabel('Shared pool').selectOption({ label: fx.pool })
  await dialog.getByLabel('Add asset (code, serial or scan)').fill(asset.assetCode)
  await dialog.getByLabel('Add asset (code, serial or scan)').press('Enter')
  await expect(dialog.getByTestId('handover-line')).toHaveCount(1)
  await dialog.getByLabel(/confirmed receipt on this screen/).check()
  await dialog.getByLabel('Confirmed by (name)').fill('Pool owner')
  // Another user issues the same asset in the meantime.
  await rpc(page, 'allocations.issue', { target: { type: 'employee', id: fx.employee.id }, lines: [{ assetId: asset.id, condition: 'good', accessories: null }], locationId: null, expectedReturnDate: null, notes: null, acknowledgment: { acknowledgedByName: 'Other' } })
  await dialog.getByRole('button', { name: 'Issue' }).click()
  await expect(dialog.getByRole('alert')).toContainText('already assigned')
  expect(await sql("SELECT 1 FROM asset_assignments WHERE asset_id = $1 AND status = 'active'", [asset.id])).toHaveLength(1)
})

test('transfers, returns and inspects through the asset page, keeping the chain of custody', async ({ page }) => {
  const asset = fx.assets[0]!
  await signIn(page, E2E_ADMIN)
  await page.goto(`/#/assets/${asset.id}`)
  const custody = page.getByRole('region', { name: 'Custody' })
  await expect(custody).toContainText(fx.employee.name)

  // Lifecycle changes are refused while the asset is assigned.
  await page.getByRole('button', { name: 'Retire', exact: true }).click()
  const retire = page.getByRole('dialog')
  await retire.getByLabel('Reason').fill('End of life')
  await retire.getByRole('button', { name: /Retire/ }).last().click()
  await expect(retire.getByRole('alert')).toContainText('Return it before changing its lifecycle status')
  await retire.getByRole('button', { name: 'Cancel' }).click()

  await custody.getByRole('button', { name: 'Transfer' }).click()
  const transfer = page.getByRole('dialog', { name: 'Transfer assets' })
  await transfer.getByLabel('Assign to').selectOption({ label: 'Shared pool' })
  await transfer.getByLabel('Shared pool').selectOption({ label: fx.pool })
  await transfer.getByLabel('Reason for transfer').fill('Employee moved to night shift pool')
  await transfer.getByLabel(/confirmed receipt on this screen/).check()
  await transfer.getByLabel('Confirmed by (name)').fill('Pool owner')
  await transfer.getByRole('button', { name: 'Transfer' }).click()
  await page.getByRole('dialog', { name: /Asset transfer receipt/ }).getByRole('button', { name: 'Close' }).click()
  await expect(custody).toContainText(fx.pool)
  await expect(custody.getByRole('table', { name: 'Assignment history' }).getByRole('row')).toHaveCount(3)

  await custody.getByRole('button', { name: 'Return' }).click()
  const ret = page.getByRole('dialog', { name: 'Receive returned assets' })
  await ret.getByLabel('Condition').selectOption({ label: 'Good' })
  await ret.getByRole('button', { name: 'Record return' }).click()
  await expect(custody).toContainText('Return recorded')
  await expect(custody).toContainText('Not assigned')
  // Not available until inspected.
  await expect(custody).toContainText('not ready for issue')
  await custody.getByRole('button', { name: 'Record inspection' }).click()
  const inspect = page.getByRole('dialog', { name: `Inspect ${asset.assetCode}` })
  await inspect.getByLabel('Inspection notes').fill('Reimaged and checked')
  await inspect.getByRole('button', { name: 'Record inspection' }).click()
  await expect(custody).toContainText('Ready to issue')

  await page.reload()
  const movements = page.getByRole('list', { name: 'Movements' })
  await expect(movements.getByRole('listitem')).toHaveCount(4)
  await expect(movements).toContainText('Inspected')
  expect((await sql<{ s: string }>('SELECT status AS s FROM asset_assignments WHERE asset_id = $1 ORDER BY assigned_at', [asset.id])).map((r) => r.s)).toEqual(['transferred', 'returned'])
})

test('reports an assigned asset lost explicitly, never silently', async ({ page }) => {
  const asset = fx.assets[1]! // still assigned to the employee from the conflict test
  await signIn(page, E2E_ADMIN)
  await page.goto(`/#/assets/${asset.id}`)
  const custody = page.getByRole('region', { name: 'Custody' })
  await custody.getByRole('button', { name: 'Report lost' }).click()
  const dialog = page.getByRole('dialog', { name: `Report ${asset.assetCode} lost` })
  await dialog.getByLabel('Reason').fill('Left in cab; police report filed')
  await dialog.getByRole('button', { name: 'Report lost' }).click()
  await expect(custody).toContainText('Ended: reported lost')
  const [row] = await sql<{ status: string; end_reason: string; life: string }>("SELECT s.status, s.end_reason, a.lifecycle_status AS life FROM asset_assignments s JOIN assets a ON a.id = s.asset_id WHERE s.asset_id = $1", [asset.id])
  expect(row).toEqual({ status: 'lost', end_reason: 'Left in cab; police report filed', life: 'lost' })
})

test('runs an exit clearance with a return, a missing item and an approved exception', async ({ page }) => {
  const [, , laptop, headset] = fx.assets
  await signIn(page, E2E_ADMIN)
  await rpc(page, 'allocations.issue', { target: { type: 'employee', id: fx.leaver.id }, lines: [laptop!, headset!].map((a) => ({ assetId: a.id, condition: 'good', accessories: null })), locationId: null, expectedReturnDate: null, notes: null, acknowledgment: { acknowledgedByName: fx.leaver.name } })

  await goTo(page, 'Exit clearance')
  await page.getByRole('button', { name: 'Open clearance' }).click()
  const open = page.getByRole('dialog', { name: 'Open exit clearance' })
  await pickEmployee(page, open, 'Employee', fx.leaver.code, fx.leaver.name)
  await open.getByLabel('Exit date').fill('2026-12-31')
  await open.getByRole('button', { name: 'Open clearance' }).click()
  await expect(page.getByRole('heading', { name: new RegExp(`EXC-\\d{6}: ${fx.leaver.name}`) })).toBeVisible()
  const items = page.getByTestId('clearance-item')
  await expect(items).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Close clearance' })).toBeDisabled()

  const laptopRow = items.filter({ hasText: laptop!.assetCode })
  await laptopRow.getByRole('button', { name: 'Record return' }).click()
  await page.getByRole('dialog', { name: `Record return of ${laptop!.assetCode}` }).getByRole('button', { name: 'Record return' }).click()
  await expect(laptopRow).toContainText('Returned')

  const headsetRow = items.filter({ hasText: headset!.assetCode })
  await headsetRow.getByRole('button', { name: 'Missing / disputed' }).click()
  const flag = page.getByRole('dialog', { name: `Flag ${headset!.assetCode}` })
  await flag.getByLabel('Reason').fill('Employee cannot find the headset')
  await flag.getByRole('button', { name: 'Flag item' }).click()
  await expect(headsetRow).toContainText('Missing')
  await expect(page.getByRole('status').filter({ hasText: 'Cannot close yet' })).toContainText(headset!.assetCode)
  // Still assigned until a decision: nothing is closed silently.
  expect(await sql("SELECT 1 FROM asset_assignments WHERE asset_id = $1 AND status = 'active'", [headset!.id])).toHaveLength(1)

  await headsetRow.getByRole('button', { name: 'Approve exception' }).click()
  const approve = page.getByRole('dialog', { name: `Approve exception for ${headset!.assetCode}` })
  await approve.getByLabel('Decision notes').fill('Written off; cost recovery not applicable')
  await approve.getByRole('button', { name: 'Approve exception' }).click()
  await expect(headsetRow).toContainText('Exception approved')

  await page.getByRole('button', { name: 'Close clearance' }).click()
  await page.getByRole('dialog', { name: 'Close clearance' }).getByRole('button', { name: 'Close clearance' }).click()
  await expect(page.getByText(/Closed with approved exceptions/)).toBeVisible()
  await page.reload()
  await expect(page.getByText(/Closed with approved exceptions/)).toBeVisible()
  const [x] = await sql<{ status: string; closure_type: string }>('SELECT status, closure_type FROM exit_clearances WHERE employee_id = $1', [fx.leaver.id])
  expect(x).toEqual({ status: 'closed', closure_type: 'with_exceptions' })
})

test('HR sees clearance status but not allocation screens or IT actions', async ({ page }) => {
  await signIn(page, E2E_USERS.hr)
  const nav = page.getByRole('navigation', { name: 'Main' })
  await expect(nav.getByRole('link', { name: 'Exit clearance', exact: true })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Allocations and returns', exact: true })).toHaveCount(0)
  await goTo(page, 'Exit clearance')
  await page.getByLabel('Status').selectOption({ label: 'All' })
  await page.getByRole('button', { name: /EXC-\d{6}/ }).first().click()
  await expect(page.getByTestId('clearance-item').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Record return' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Approve exception' })).toHaveCount(0)
  const denied = await page.request.post('/api/v1/rpc/allocations.list', { headers: { 'x-bpoam-request': '1', 'content-type': 'application/json' }, data: {} })
  expect(denied.status()).toBe(403)
})

test('signed-receipt policy: the handover stays pending until the signed copy is attached', async ({ page }) => {
  const asset = fx.assets[4]!
  await signIn(page, E2E_ADMIN)
  await goTo(page, 'Settings')
  await page.getByLabel('Handover acknowledgment').selectOption({ label: 'Printed receipt, signed and attached afterwards' })
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByText('Settings saved.')).toBeVisible()
  try {
    await goTo(page, 'Allocations and returns')
    await page.getByRole('button', { name: 'Issue assets' }).click()
    const dialog = page.getByRole('dialog', { name: 'Issue assets' })
    await pickEmployee(page, dialog, 'Employee', fx.employee.code, fx.employee.name)
    await dialog.getByLabel('Add asset (code, serial or scan)').fill(asset.assetCode)
    await dialog.getByLabel('Add asset (code, serial or scan)').press('Enter')
    await expect(dialog.getByText(/signed receipt/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Issue' }).click()
    const receipt = page.getByRole('dialog', { name: /Asset issue receipt/ })
    await expect(receipt.getByText('Acknowledgment pending.')).toBeVisible()
    await receipt.getByTestId('signed-receipt-file').setInputFiles({ name: 'signed-receipt.pdf', mimeType: 'application/pdf', buffer: PDF })
    await expect(receipt.getByText(/Acknowledged — Signed receipt attached/)).toBeVisible()
    await expect(receipt.getByText('signed-receipt.pdf', { exact: true })).toBeVisible()
  } finally {
    await rpc(page, 'settings.update', { handoverAcknowledgment: 'in_app' })
  }
})

test('an expired session during a handover returns to sign-in without saving', async ({ page }) => {
  const asset = fx.assets[2]! // returned via clearance and awaiting inspection: use a fresh lookup that fails on save
  await signIn(page, E2E_USERS.assetManager)
  await goTo(page, 'Allocations and returns')
  await page.getByRole('button', { name: 'Issue assets' }).click()
  const dialog = page.getByRole('dialog', { name: 'Issue assets' })
  // Let the dialog's own background lookups (settings, departments, locations) finish first, so the
  // session revoke below can only affect the asset lookup the test triggers next, not an unrelated race.
  await dialog.getByLabel('Add asset (code, serial or scan)').waitFor({ state: 'visible' })
  await page.waitForLoadState('networkidle')
  await sql("UPDATE sessions SET revoked_at = now(), revoke_reason = 'expired_test' WHERE revoked_at IS NULL AND user_id = (SELECT id FROM users WHERE username_normalized = $1)", [E2E_USERS.assetManager.username])
  await dialog.getByLabel('Add asset (code, serial or scan)').fill(asset.assetCode)
  await dialog.getByLabel('Add asset (code, serial or scan)').press('Enter')
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await expect(page.getByText(/session has expired/)).toBeVisible()
})
