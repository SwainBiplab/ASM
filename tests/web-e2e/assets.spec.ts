import { readFileSync } from 'node:fs'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { E2E_ADMIN, E2E_USERS } from './accounts'
import { goTo, signIn, sql, uniq } from './helpers'

// A tiny but valid PDF (magic bytes are checked by the server).
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1')

test.describe.configure({ mode: 'serial' })

let assetCode = ''
let assetId = ''
let documentId = ''
const serial = `SN-${uniq()}`
const categoryName = `Laptops ${uniq()}`
const categoryCode = `L${Date.now().toString(36).slice(-6).toUpperCase()}`

async function openAsset(page: Page) {
  await goTo(page, 'Assets')
  await page.getByLabel('Search').fill(assetCode)
  await page.getByRole('button', { name: assetCode, exact: true }).click()
  await expect(page.getByRole('heading', { name: assetCode, exact: true })).toBeVisible()
}

async function asUser(browser: Browser, user: { username: string; password: string }) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await signIn(page, user)
  return { context, page }
}

test('registers an asset through the catalogue and register screens', async ({ page }) => {
  await signIn(page, E2E_ADMIN)
  await goTo(page, 'Asset catalogue')
  await page.getByRole('button', { name: 'Add category' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name').fill(categoryName)
  await dialog.getByLabel('Code').fill(categoryCode)
  await dialog.getByRole('button', { name: /Add category|Save/ }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('row').filter({ hasText: categoryName })).toHaveCount(1)

  await goTo(page, 'Assets')
  await page.getByRole('button', { name: 'Add asset' }).click()
  await dialog.getByLabel('Category').selectOption({ label: categoryName })
  await dialog.getByLabel('Manufacturer').fill('Lenovo')
  await dialog.getByLabel('Model name').fill('ThinkPad E14')
  await dialog.getByLabel(/^Serial number/).fill(serial)
  await dialog.getByLabel('Acquisition cost').fill('54999.50')
  await dialog.getByRole('button', { name: 'Register asset' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText(/AST-\d{6} was registered\./)).toBeVisible()

  const [row] = await sql<{ id: string; code: string; cost: number }>('SELECT id, asset_code AS code, acquisition_cost_minor AS cost FROM assets WHERE serial_number = $1', [serial])
  expect(Number(row!.cost)).toBe(5499950)
  assetCode = row!.code
  assetId = row!.id
  await expect(page.getByRole('heading', { name: assetCode, exact: true })).toBeVisible()
})

test('a lost response does not register the asset twice (idempotent retry)', async ({ page }) => {
  const retrySerial = `RETRY-${uniq()}`
  await signIn(page, E2E_ADMIN)
  let attempts = 0
  const keys: string[] = []
  await page.route('**/api/v1/rpc/assets.create', async (route) => {
    attempts += 1
    keys.push(route.request().headers()['idempotency-key'] ?? '')
    if (attempts === 1) {
      await route.fetch() // the server commits the asset...
      return route.abort('connectionreset') // ...but the browser never sees the response
    }
    return route.continue()
  })
  await goTo(page, 'Assets')
  await page.getByRole('button', { name: 'Add asset' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Category').selectOption({ label: categoryName })
  await dialog.getByLabel(/^Serial number/).fill(retrySerial)
  await dialog.getByRole('button', { name: 'Register asset' }).click()
  await expect(page.getByText(/AST-\d{6} was registered\./)).toBeVisible()
  expect(attempts).toBe(2)
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/)
  expect(keys[1]).toBe(keys[0])
  expect(await sql('SELECT 1 FROM assets WHERE serial_number = $1', [retrySerial])).toHaveLength(1)
})

test('finds the asset by search, scanner lookup and after a reload', async ({ page }) => {
  await signIn(page, E2E_ADMIN)
  await openAsset(page)
  await expect(page.getByText('Lenovo').first()).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: assetCode, exact: true })).toBeVisible()

  await goTo(page, 'Scan / find asset')
  const scan = page.getByLabel('Asset code, serial number or QR label')
  // A USB scanner types the code and sends Enter; serial lookups are exact and case-insensitive.
  await scan.fill(serial.toLowerCase())
  await scan.press('Enter')
  await expect(page.getByRole('status').filter({ hasText: `Found ${assetCode} by serial number.` })).toBeVisible()
  await page.getByRole('button', { name: 'Open asset' }).click()
  await expect(page).toHaveURL(new RegExp(`#/assets/${assetId}$`))
  await expect(page.getByRole('heading', { name: assetCode, exact: true })).toBeVisible()

  // Manual entry of the asset code with the Find button, and an unknown code.
  await goTo(page, 'Scan / find asset')
  await page.getByLabel('Asset code, serial number or QR label').fill(assetCode)
  await page.getByRole('button', { name: 'Find' }).click()
  await expect(page.getByRole('status').filter({ hasText: assetCode })).toBeVisible()
  await page.getByLabel('Asset code, serial number or QR label').fill('AST-999999')
  await page.getByRole('button', { name: 'Find' }).click()
  await expect(page.getByRole('heading', { name: 'Result for "AST-999999"' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open asset' })).toHaveCount(0)
})

test('generates printable labels with QR and barcode artwork', async ({ page }) => {
  await signIn(page, E2E_ADMIN)
  await openAsset(page)
  await page.getByRole('button', { name: 'Print label' }).click()
  const sheet = page.getByRole('dialog', { name: 'Asset labels' })
  await expect(sheet.getByText('1 label')).toBeVisible()
  await expect(sheet.getByAltText(`QR code for ${assetCode}`)).toHaveAttribute('src', /^data:image\/(png|svg\+xml);base64,/)
  await expect(sheet.getByAltText(`Barcode for ${assetCode}`)).toHaveAttribute('src', /^data:image\/(png|svg\+xml);base64,/)
  await expect(sheet.getByRole('button', { name: 'Print' })).toBeEnabled()
  await sheet.getByRole('button', { name: 'Close' }).click()
})

test('uploads a document and downloads exactly the same bytes', async ({ page }) => {
  await signIn(page, E2E_ADMIN)
  await openAsset(page)
  await page.getByLabel('File', { exact: true }).setInputFiles({ name: 'invoice-0042.pdf', mimeType: 'application/pdf', buffer: PDF })
  await page.getByRole('button', { name: 'Upload' }).click()
  await expect(page.getByText('Uploaded invoice-0042.pdf.')).toBeVisible()
  const docRow = page.locator('.doc-row').filter({ hasText: 'invoice-0042.pdf' })
  await expect(docRow).toContainText('Not scanned')
  // Storage keys and server paths never reach the browser.
  const [doc] = await sql<{ id: string; storage_key: string }>('SELECT d.id, d.storage_key FROM documents d JOIN document_links l ON l.document_id = d.id WHERE l.entity_id = $1', [assetId])
  documentId = doc!.id
  expect(await page.content()).not.toContain(doc!.storage_key)

  const downloadPromise = page.waitForEvent('download')
  await docRow.getByRole('button', { name: 'Download' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('invoice-0042.pdf')
  expect(readFileSync((await download.path())!)).toEqual(PDF)

  // A disallowed file type is refused with a clear message and nothing is stored.
  await page.getByLabel('File', { exact: true }).setInputFiles({ name: 'run.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ\x90\x00') })
  await page.getByRole('button', { name: 'Upload' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  expect(await sql('SELECT 1 FROM document_links WHERE entity_id = $1', [assetId])).toHaveLength(1)
})

test('document content is refused without permission or without a session', async ({ browser }) => {
  const url = `/api/v1/documents/${documentId}/content`
  const hr = await asUser(browser, E2E_USERS.hr)
  const denied = await hr.page.request.get(url)
  expect(denied.status()).toBe(403)
  expect((await denied.json()).error.code).toBe('PERMISSION_DENIED')
  await hr.context.close()

  const anon = await browser.newContext()
  const res = await anon.request.get(`${test.info().project.use.baseURL}${url}`)
  expect(res.status()).toBe(401)
  expect(await res.text()).not.toContain('%PDF')
  await anon.close()
})

test('exports respect the cost permission and hide cost from users without it', async ({ page, browser }) => {
  await signIn(page, E2E_ADMIN)
  await goTo(page, 'Assets')
  await page.getByLabel('Search').fill(assetCode)
  const adminDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export CSV' }).click()
  const adminCsv = readFileSync((await (await adminDownload).path())!, 'utf8')
  expect(adminCsv.split(/\r?\n/)[0]).toMatch(/cost/i)
  expect(adminCsv).toContain(assetCode)
  expect(adminCsv).toContain('5499950') // minor units, as specified for exports

  const mgr = await asUser(browser, E2E_USERS.assetManager)
  await goTo(mgr.page, 'Assets')
  await mgr.page.getByLabel('Search').fill(assetCode)
  await mgr.page.getByRole('button', { name: assetCode, exact: true }).click()
  await expect(mgr.page.getByRole('heading', { name: assetCode, exact: true })).toBeVisible()
  await expect(mgr.page.getByText('54,999.50')).toHaveCount(0)
  const mgrDownload = mgr.page.waitForEvent('download')
  await mgr.page.getByRole('button', { name: 'Export CSV' }).click()
  const mgrCsv = readFileSync((await (await mgrDownload).path())!, 'utf8')
  expect(mgrCsv).toContain(assetCode)
  expect(mgrCsv.split(/\r?\n/)[0]).not.toMatch(/cost/i)
  expect(mgrCsv).not.toContain('5499950')
  // The API response for the same user carries no cost field at all.
  const detail = await mgr.page.request.post('/api/v1/rpc/assets.get', { headers: { 'x-bpoam-request': '1', 'content-type': 'application/json' }, data: { id: assetId } })
  expect(JSON.stringify(await detail.json())).not.toContain('5499950')
  await mgr.context.close()

  // The HR officer has no export permission at all.
  const hr = await asUser(browser, E2E_USERS.hr)
  const refused = await hr.page.request.get('/api/v1/exports/assets.csv')
  expect(refused.status()).toBe(403)
  await hr.context.close()
})
