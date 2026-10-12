import { expect, test } from '@playwright/test'
import { E2E_ADMIN, E2E_USERS } from './accounts'
import { goTo, signIn, sql } from './helpers'

test('signs in, restores the session after reload, and signs out', async ({ page, context }) => {
  await signIn(page, E2E_ADMIN)
  await expect(page.getByRole('banner')).toContainText(E2E_ADMIN.displayName)
  // The session lives only in an HttpOnly cookie; scripts and Web Storage never see it.
  const cookie = (await context.cookies()).find((c) => c.name === 'bpoam_sid')
  expect(cookie?.httpOnly).toBe(true)
  expect(cookie?.sameSite).toBe('Lax')
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))).toBe('{}{}')

  await page.reload()
  await expect(page.getByRole('banner')).toContainText(E2E_ADMIN.displayName)
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await expect(page.getByText('You have signed out.')).toBeVisible()
  expect((await context.cookies()).some((c) => c.name === 'bpoam_sid')).toBe(false)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
})

test('rejects wrong credentials with a generic message', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Username').fill(E2E_ADMIN.username)
  await page.getByLabel('Password').fill('not-the-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toContainText(/incorrect|invalid/i)
  await expect(page.getByLabel('Password')).toHaveValue('')
})

test('forces a password change when an administrator set the password', async ({ page }) => {
  const u = E2E_USERS.newStaff
  await page.goto('/')
  await page.getByLabel('Username').fill(u.username)
  await page.getByLabel('Password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Change password' })).toBeVisible()
  await page.getByLabel('Current password').fill(u.password)
  await page.getByLabel('New password', { exact: true }).fill('Chosen-E2E-Pass-9')
  await page.getByLabel('Confirm new password').fill('Chosen-E2E-Pass-9')
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
  const [row] = await sql<{ must: boolean }>('SELECT must_change_password AS must FROM users WHERE username_normalized = $1', [u.username])
  expect(row!.must).toBe(false)
})

test('an expired session returns the user to sign-in with an explanation', async ({ page }) => {
  await signIn(page, E2E_USERS.assetManager)
  // Simulate the idle timeout passing on the server.
  await sql(
    "UPDATE sessions SET last_seen_at = now() - interval '6 hours' WHERE revoked_at IS NULL AND user_id = (SELECT id FROM users WHERE username_normalized = $1)",
    [E2E_USERS.assetManager.username]
  )
  await goTo(page, 'Assets')
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await expect(page.getByText(/session has expired/)).toBeVisible()
  await signIn(page, E2E_USERS.assetManager)
})

test('shows a meaningful, retryable error when the server cannot be reached', async ({ page }) => {
  await signIn(page, E2E_ADMIN)
  await page.route('**/api/v1/rpc/dashboard.getSummary', (route) => route.abort('connectionrefused'))
  await page.reload()
  await expect(page.getByRole('alert')).toContainText('The server could not be reached')
  await page.unroute('**/api/v1/rpc/dashboard.getSummary')
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByLabel('System summary')).toBeVisible()
})

test('a server error shows a reference, never internal details', async ({ page }) => {
  await signIn(page, E2E_ADMIN)
  await page.route('**/api/v1/rpc/dashboard.getSummary', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'The operation could not be completed. Reference: ref-123', correlationId: 'ref-123' } }) })
  )
  await page.reload()
  await expect(page.getByRole('alert')).toContainText('Reference ref-123')
  await expect(page.getByRole('alert')).not.toContainText(/stack|SELECT|Error:/)
})

test('sign-in and the dashboard fit a phone-width screen and work with the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  // Keyboard only: the username field is focused, Tab moves to password, Enter submits.
  await expect(page.getByLabel('Username')).toBeFocused()
  await page.keyboard.type(E2E_ADMIN.username)
  await page.keyboard.press('Tab')
  await page.keyboard.type(E2E_ADMIN.password)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
  await expect(page.getByLabel('System summary')).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})
