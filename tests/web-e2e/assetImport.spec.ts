import { expect, test, type Page } from '@playwright/test'
import { E2E_ADMIN } from './accounts'
import { goTo, signIn, sql, uniq } from './helpers'

const csv = (lines: string[]) => ({ name: 'assets.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\r\n'), 'utf8') })
const countAssets = async () => Number((await sql<{ n: string }>('SELECT count(*) AS n FROM assets'))[0]!.n)

async function openImport(page: Page) {
  await goTo(page, 'Assets')
  await page.getByRole('button', { name: 'Import CSV/Excel' }).click()
  await expect(page.getByRole('heading', { name: 'Import assets from CSV or Excel' })).toBeVisible()
}

test('CSV import previews every row, blocks nothing, and commits accepted rows with system-issued codes', async ({ page }) => {
  const p = uniq()
  const categoryName = `Import Laptops ${p}`
  const before = await countAssets()

  await signIn(page, E2E_ADMIN)
  await goTo(page, 'Asset catalogue')
  await page.getByRole('button', { name: 'Add category' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name').fill(categoryName)
  await dialog.getByLabel('Code').fill(`IMP${p}`.slice(0, 20))
  await dialog.getByRole('button', { name: /Add category|Save/ }).click()
  await expect(dialog).toHaveCount(0)

  await openImport(page)
  await page.getByTestId('import-file').setInputFiles(
    csv(['Category,Manufacturer,Model,Serial Number', `${categoryName},Dell,Latitude 5420,SN-${p}-1`, `${categoryName},HP,EliteBook 840,SN-${p}-2`])
  )
  await expect(page.getByText('All 2 row(s) passed validation.')).toBeVisible()
  expect(await countAssets()).toBe(before) // preview writes nothing

  await page.getByRole('button', { name: 'Import 2 assets' }).click()
  await expect(page.getByText('2 assets imported.')).toBeVisible()
  expect(await countAssets()).toBe(before + 2)
  const rows = await sql<{ code: string; manufacturer: string }>('SELECT asset_code AS code, manufacturer FROM assets WHERE serial_number LIKE $1 ORDER BY 1', [`SN-${p}-%`])
  expect(rows).toHaveLength(2)
  for (const r of rows) expect(r.code).toMatch(/^AST-\d{6}$/)
})

test('a row referencing a category that does not exist is rejected and blocks the commit until skipped', async ({ page }) => {
  const p = uniq()
  await signIn(page, E2E_ADMIN)
  await openImport(page)
  await page.getByTestId('import-file').setInputFiles(csv(['Category,Serial Number', `Nonexistent Category ${p},SN-${p}`]))
  await expect(page.getByText(/1 row\(s\) cannot be imported/)).toBeVisible()
  await expect(page.getByRole('button', { name: /Import \d+ asset/ })).toBeDisabled()
  await page.getByLabel(/Skip the 1 rejected/).check()
  await expect(page.getByRole('button', { name: /Import \d+ asset/ })).toBeDisabled() // 0 accepted rows left to import
})
