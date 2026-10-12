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
      }
    ]
  }
})
