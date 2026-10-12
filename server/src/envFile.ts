import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'

/**
 * Loads `KEY=value` lines from a local `.env` file (or `ENV_FILE`) for development convenience.
 * Variables already set in the real environment always win, so a platform secret store or a
 * shell export overrides the file. The file is git-ignored; `.env.example` is the template.
 * Returns the path that was loaded, or null when there is no file.
 */
export function loadEnvFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = resolve(env['ENV_FILE'] ?? '.env')
  if (!existsSync(path)) return null
  const values = parseEnv(readFileSync(path, 'utf8'))
  for (const [key, value] of Object.entries(values)) {
    if (env[key] === undefined && value !== undefined) env[key] = value
  }
  return path
}
