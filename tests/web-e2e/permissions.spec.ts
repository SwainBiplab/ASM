import { expect, test } from '@playwright/test'
import { E2E_ADMIN, E2E_USERS } from './accounts'
import { E2E_BASE_URL } from './env'
import { goTo, signIn } from './helpers'

const rpc = (command: string) => `/api/v1/rpc/${command}`
const CSRF = { 'x-bpoam-request': '1' }
const JSON_CSRF = { ...CSRF, 'content-type': 'application/json' }

test('navigation follows permissions and the server denies hidden operations', async ({ page }) => {
  await signIn(page, E2E_USERS.hr)
  const nav = page.getByRole('navigation', { name: 'Main' })
  await expect(nav.getByRole('link', { name: 'Employees', exact: true })).toBeVisible()
  for (const hidden of ['Assets', 'Asset catalogue', 'Scan / find asset', 'Users and roles', 'Audit log']) {
    await expect(nav.getByRole('link', { name: hidden, exact: true })).toHaveCount(0)
  }
  // Typing a hidden route does not open it.
  await page.goto('/#/assets')
  await expect(page.getByRole('heading', { name: 'Assets', exact: true })).toHaveCount(0)

  // Hiding is convenience only: the server refuses the operation for this session.
  const denied = await page.request.post(rpc('assets.search'), { headers: JSON_CSRF, data: { page: 1, pageSize: 10 } })
  expect(denied.status()).toBe(403)
  expect((await denied.json()).error.code).toBe('PERMISSION_DENIED')
  const users = await page.request.post(rpc('users.list'), { headers: CSRF })
  expect(users.status()).toBe(403)
})

test('read-only access hides management actions and the server rejects them', async ({ page }) => {
  await signIn(page, E2E_USERS.assetManager)
  await goTo(page, 'Employees')
  await expect(page.getByRole('heading', { name: 'Employees', exact: true, level: 1 })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add employee' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Import CSV' })).toHaveCount(0)
  const res = await page.request.post(rpc('employees.create'), {
    headers: { ...JSON_CSRF, 'idempotency-key': crypto.randomUUID() },
    data: {
      employeeCode: 'X-DENIED', fullName: 'Denied Person', email: null, phone: null, jobTitle: null, departmentId: null, teamId: null,
      managerEmployeeId: null, workLocationId: null, employmentStatus: 'active', joiningDate: null, expectedExitDate: null, notes: null
    }
  })
  expect(res.status()).toBe(403)
  expect((await res.json()).error.code).toBe('PERMISSION_DENIED')
})

test('requests without the CSRF header or from another origin are rejected', async ({ page }) => {
  await signIn(page, E2E_ADMIN)
  const noHeader = await page.request.post(rpc('users.list'))
  expect(noHeader.status()).toBe(403)
  expect((await noHeader.json()).error.code).toBe('FORBIDDEN_SENDER')
  const foreign = await page.request.post(rpc('users.list'), { headers: { ...CSRF, origin: 'https://evil.example' } })
  expect(foreign.status()).toBe(403)
  const sameOrigin = await page.request.post(rpc('users.list'), { headers: { ...CSRF, origin: E2E_BASE_URL } })
  expect(sameOrigin.status()).toBe(200)
})

test('the app is served with a strict content security policy', async ({ page }) => {
  const res = await page.goto('/')
  const csp = res!.headers()['content-security-policy'] ?? ''
  expect(csp).toContain("script-src 'self'")
  expect(csp).toContain("frame-ancestors 'none'")
  expect(res!.headers()['x-content-type-options']).toBe('nosniff')
  const api404 = await page.request.get('/api/v1/nope')
  expect(api404.status()).toBe(404)
  expect((await api404.json()).ok).toBe(false)
})
