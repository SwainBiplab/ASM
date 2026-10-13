import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { E2E_ADMIN } from './accounts'
import { signIn } from './helpers'

/**
 * Automated baseline for KNOWN_ISSUES W-15 ("no full accessibility audit... has been done").
 * This is axe-core's automated WCAG2A/2AA ruleset (contrast, ARIA, labels, landmarks, etc.) against
 * every main screen while signed in, plus the sign-in page itself -- real, broad coverage, but it
 * is not a substitute for manual screen-reader testing, which axe-core cannot perform.
 */
const ROUTES = [
  'dashboard', 'scan', 'allocations', 'exit-clearance', 'maintenance', 'procurement', 'approvals',
  'orders', 'receipts', 'audits', 'assets', 'catalog', 'employees', 'locations', 'reports', 'users', 'audit-log', 'settings'
]

async function scan(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  return results.violations
}

function describeViolations(violations: Awaited<ReturnType<typeof scan>>): string {
  return violations
    .map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.length} node(s), e.g. ${v.nodes[0]?.target.join(' ')}`)
    .join('\n')
}

test('sign-in page has no automated accessibility violations', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByLabel('Username')).toBeVisible()
  const violations = await scan(page)
  expect(violations, describeViolations(violations)).toEqual([])
})

for (const route of ROUTES) {
  test(`"${route}" screen has no automated accessibility violations`, async ({ page }) => {
    await signIn(page, E2E_ADMIN)
    await page.goto(`/#/${route}`)
    await page.waitForLoadState('networkidle')
    const violations = await scan(page)
    expect(violations, describeViolations(violations)).toEqual([])
  })
}
