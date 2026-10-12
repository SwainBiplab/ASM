import { expect, test, type Page } from '@playwright/test'
import { E2E_ADMIN } from './accounts'
import { goTo, signIn, sql, uniq } from './helpers'

const csv = (lines: string[]) => ({ name: 'employees.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\r\n'), 'utf8') })
const countEmployees = async () => Number((await sql<{ n: string }>('SELECT count(*) AS n FROM employees'))[0]!.n)

async function openImport(page: Page) {
  await goTo(page, 'Employees')
  await page.getByRole('button', { name: 'Import CSV' }).click()
  await expect(page.getByRole('heading', { name: 'Import employees from CSV' })).toBeVisible()
}

test('dashboard figures come from the database', async ({ page }) => {
  await signIn(page, E2E_ADMIN)
  const [{ users }] = (await sql<{ users: string }>('SELECT count(*) AS users FROM users WHERE is_active')) as [{ users: string }]
  const summary = page.getByLabel('System summary')
  await expect(summary.locator('.ledger__cell').filter({ hasText: 'Active user accounts' }).locator('.ledger__value')).toHaveText(String(users))
  const [{ n }] = (await sql<{ n: string }>("SELECT count(*) AS n FROM assets WHERE lifecycle_status NOT IN ('lost','retired','disposed')")) as [{ n: string }]
  await expect(page.getByLabel('Asset summary').getByRole('button').filter({ hasText: 'Active assets' }).locator('.ledger__value')).toHaveText(String(n))
})

test('creates an employee, finds it by search, and it survives a reload', async ({ page }) => {
  const code = `E2E-${uniq()}`
  await signIn(page, E2E_ADMIN)
  await goTo(page, 'Employees')
  await page.getByRole('button', { name: 'Add employee' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Employee ID').fill(code)
  await dialog.getByLabel('Full name').fill('Priya <b>Raman</b>')
  await dialog.getByLabel('Email').fill(`${code.toLowerCase()}@bpo.example`)
  await dialog.getByRole('button', { name: 'Add employee' }).click()
  await expect(dialog).toHaveCount(0)

  await page.getByLabel('Search').fill(code)
  const row = page.getByRole('row').filter({ hasText: code })
  await expect(row).toHaveCount(1)
  // User-entered text is rendered as text, never as markup.
  await expect(row).toContainText('Priya <b>Raman</b>')
  await expect(row.locator('b')).toHaveCount(0)

  await page.reload()
  await page.getByLabel('Search').fill(code)
  await expect(page.getByRole('row').filter({ hasText: code })).toHaveCount(1)
  const rows = await sql<{ full_name: string }>('SELECT full_name FROM employees WHERE employee_code = $1', [code])
  expect(rows).toEqual([{ full_name: 'Priya <b>Raman</b>' }])

  // Duplicate employee IDs are refused by the server and explained in the form.
  await page.getByRole('button', { name: 'Add employee' }).click()
  await dialog.getByLabel('Employee ID').fill(code)
  await dialog.getByLabel('Full name').fill('Someone Else')
  await dialog.getByRole('button', { name: 'Add employee' }).click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  expect(await sql('SELECT 1 FROM employees WHERE employee_code = $1', [code])).toHaveLength(1)
})

test('CSV import previews every row and commits all accepted rows', async ({ page }) => {
  const p = uniq()
  const before = await countEmployees()
  await signIn(page, E2E_ADMIN)
  await openImport(page)
  await page.getByTestId('import-file').setInputFiles(csv(['Employee ID,Full Name,Email,Status', `IMP-${p}-1,Ravi Kumar,ravi.${p}@bpo.example,Active`, `IMP-${p}-2,"Menon, Asha",,On leave`]))
  await expect(page.getByText('All 2 row(s) passed validation.')).toBeVisible()
  expect(await countEmployees()).toBe(before) // preview writes nothing
  await page.getByRole('button', { name: 'Import 2 employees' }).click()
  await expect(page.getByText('2 employees imported.')).toBeVisible()
  expect(await countEmployees()).toBe(before + 2)
  expect((await sql('SELECT employee_code FROM employees WHERE employee_code LIKE $1 ORDER BY 1', [`IMP-${p}-%`])).length).toBe(2)
})

test('CSV import with rejected rows cannot be committed and writes nothing', async ({ page }) => {
  const p = uniq()
  const before = await countEmployees()
  await signIn(page, E2E_ADMIN)
  await openImport(page)
  await page.getByTestId('import-file').setInputFiles(csv(['Employee ID,Full Name', `BAD-${p}-1,Valid Person`, `BAD-${p}-2,`, `BAD-${p}-1,Duplicate In File`]))
  await expect(page.getByText(/row\(s\) cannot be imported/)).toBeVisible()
  await expect(page.getByRole('button', { name: /^Import \d+ employee/ })).toBeDisabled()
  await page.getByRole('button', { name: 'Cancel import' }).last().click()
  await expect(page.getByRole('heading', { name: 'Employees', exact: true, level: 1 })).toBeVisible()
  expect(await countEmployees()).toBe(before)
})

test('CSV import rolls back completely when the server re-validation fails at commit', async ({ page }) => {
  const p = uniq()
  const before = await countEmployees()
  await signIn(page, E2E_ADMIN)
  await openImport(page)
  await page.getByTestId('import-file').setInputFiles(csv(['Employee ID,Full Name', `RB-${p}-1,First Person`, `RB-${p}-2,Second Person`]))
  await expect(page.getByText('All 2 row(s) passed validation.')).toBeVisible()
  // Someone else creates one of the employee IDs between preview and commit.
  const [org] = await sql<{ id: string }>('SELECT id FROM organizations LIMIT 1')
  await sql("INSERT INTO employees (id, organization_id, employee_code, employee_code_normalized, full_name, employment_status) VALUES (gen_random_uuid(), $1, $2, upper($2), 'Concurrent Hire', 'active')", [org!.id, `RB-${p}-2`])
  await page.getByRole('button', { name: 'Import 2 employees' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  // Neither row was written: the import is all-or-nothing.
  expect(await sql('SELECT 1 FROM employees WHERE employee_code = $1', [`RB-${p}-1`])).toHaveLength(0)
  expect(await countEmployees()).toBe(before + 1)
})
