import { defineConfig, devices } from '@playwright/test'
import { E2E_BASE_URL } from './tests/web-e2e/env'

/** Browser E2E for the web application (W3): real API process + real PostgreSQL. */
export default defineConfig({
  testDir: 'tests/web-e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './tests/web-e2e/global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  outputDir: 'test-results/web-e2e/artifacts',
  use: {
    baseURL: E2E_BASE_URL,
    ...devices['Desktop Chrome'],
    acceptDownloads: true,
    trace: 'retain-on-failure'
  }
})
