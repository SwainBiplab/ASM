import { join, resolve } from 'node:path'

/** Fixed so the Playwright runner and its workers agree (the config is loaded in every process). */
export const E2E_PORT = Number(process.env['E2E_PORT'] ?? 4319)
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`
export const STATE_FILE = join(resolve(__dirname, '../..'), 'test-results/web-e2e/state.json')
