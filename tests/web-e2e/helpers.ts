import { readFileSync } from 'node:fs'
import { expect, type Page } from '@playwright/test'
import pg from 'pg'
import { STATE_FILE } from './env'

/** Direct SQL against the E2E database, for arranging state (e.g. expiry) and verifying persistence. */
export async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const { databaseUrl } = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { databaseUrl: string }
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    return (await client.query(text, params)).rows as T[]
  } finally {
    await client.end()
  }
}

export async function signIn(page: Page, user: { username: string; password: string }): Promise<void> {
  await page.goto('/')
  await page.getByLabel('Username').fill(user.username)
  await page.getByLabel('Password').fill(user.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
}

export async function goTo(page: Page, label: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: label, exact: true }).click()
}

/** Unique suffix so specs never collide on the shared E2E database. */
export const uniq = (): string => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
