import { expect, test } from '@playwright/test'
import { E2E_ADMIN } from './accounts'
import { goTo, signIn, sql, uniq } from './helpers'

test('builds departments, locations, workstations and pools through the browser', async ({ page }) => {
  const p = uniq()
  await signIn(page, E2E_ADMIN)
  await goTo(page, 'Departments and locations')
  const dialog = page.getByRole('dialog')

  await page.getByRole('button', { name: 'Add department' }).click()
  await dialog.getByLabel('Name').fill(`Operations ${p}`)
  await dialog.getByRole('button', { name: 'Add department' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('row').filter({ hasText: `Operations ${p}` })).toHaveCount(1)

  await page.getByRole('tab', { name: 'Locations' }).click()
  await page.getByRole('button', { name: 'Add office / site' }).click()
  await dialog.getByLabel('Name').fill(`Pune Campus ${p}`)
  await dialog.getByRole('button', { name: 'Add location' }).click()
  await expect(dialog).toHaveCount(0)
  const site = page.getByRole('row').filter({ hasText: `Pune Campus ${p}` })
  await site.getByRole('button', { name: 'Add inside' }).click()
  await dialog.getByLabel('Name').fill(`Tower A ${p}`)
  await dialog.getByLabel('Type').selectOption({ label: 'Building' })
  await dialog.getByRole('button', { name: 'Add location' }).click()
  await expect(dialog).toHaveCount(0)
  await page.getByRole('row').filter({ hasText: `Tower A ${p}` }).getByRole('button', { name: 'Add inside' }).click()
  await dialog.getByLabel('Name').fill(`Floor 3 ${p}`)
  await dialog.getByLabel('Type').selectOption({ label: 'Floor' })
  await dialog.getByRole('button', { name: 'Add location' }).click()
  await expect(dialog).toHaveCount(0)

  await page.getByRole('tab', { name: 'Workstations and seats' }).click()
  await page.getByRole('button', { name: 'Add workstation' }).click()
  await dialog.getByLabel('Code').fill(`PUN-3A-${p}`)
  await dialog.getByLabel('Location').selectOption({ label: `Pune Campus ${p} / Tower A ${p} / Floor 3 ${p}` })
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('row').filter({ hasText: `PUN-3A-${p}` })).toHaveCount(1)

  await page.getByRole('tab', { name: 'Shared asset pools' }).click()
  await page.getByRole('button', { name: 'Add pool' }).click()
  await dialog.getByLabel('Name').fill(`Spare headsets ${p}`)
  await dialog.getByRole('button', { name: 'Add pool' }).click()
  // The server requires an owner; the form shows its field message instead of saving.
  await expect(dialog.getByRole('alert')).toContainText('Some fields are invalid')
  await dialog.getByLabel('Responsible department').selectOption({ label: `Operations ${p}` })
  await dialog.getByRole('button', { name: 'Add pool' }).click()
  await expect(dialog).toHaveCount(0)

  // Everything is persisted on the server and still shown after a reload.
  await page.reload()
  await page.getByRole('tab', { name: 'Shared asset pools' }).click()
  await expect(page.getByRole('row').filter({ hasText: `Spare headsets ${p}` })).toHaveCount(1)
  const [counts] = await sql<{ d: string; l: string; w: string; p: string }>(
    `SELECT (SELECT count(*) FROM departments WHERE name = $1) AS d, (SELECT count(*) FROM locations WHERE name IN ($2, $3, $6)) AS l,
            (SELECT count(*) FROM workstations WHERE code = $4) AS w, (SELECT count(*) FROM asset_pools WHERE name = $5) AS p`,
    [`Operations ${p}`, `Pune Campus ${p}`, `Floor 3 ${p}`, `PUN-3A-${p}`, `Spare headsets ${p}`, `Tower A ${p}`]
  )
  expect(counts).toEqual({ d: '1', l: '3', w: '1', p: '1' })
})

test('the audit log records browser actions', async ({ page }) => {
  await signIn(page, E2E_ADMIN)
  await goTo(page, 'Audit log')
  await expect(page.getByRole('cell', { name: /session|login|signed/i }).first()).toBeVisible()
})
