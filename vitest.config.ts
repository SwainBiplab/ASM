import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const alias = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'prototype',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
          // Integration tests use real SQLite files; keep them isolated per file.
          pool: 'forks',
          testTimeout: 20000
        }
      },
      {
        resolve: { alias },
        test: {
          name: 'server',
          environment: 'node',
          include: ['tests/server/**/*.test.ts'],
          // A real, ephemeral PostgreSQL cluster for the whole run; one database per test file.
          globalSetup: ['tests/server/global-setup.ts'],
          pool: 'forks',
          testTimeout: 30000,
          hookTimeout: 60000
        }
      },
      {
        resolve: { alias },
        test: {
          name: 'agent',
          environment: 'node',
          include: ['tests/agent/**/*.test.ts'],
          // Real SQLite files on disk, like the prototype's own integration tests; isolate per file.
          pool: 'forks'
        }
      },
      {
        resolve: { alias },
        test: {
          name: 'web',
          environment: 'node',
          // web/src/api.ts's browser behavior is otherwise proven by the real Playwright suite
          // (test:web-e2e); this project covers the pure adapter-swap logic (W9.6) that doesn't
          // need a real browser at all, without adding a jsdom dependency just for it.
          include: ['tests/web/**/*.test.ts']
        }
      }
    ]
  }
})
