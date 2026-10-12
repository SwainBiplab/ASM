// Fills the development database with demo data (never the installed app's data).
// Usage: close the running app, then: npm run seed:demo
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const build = spawnSync('npx', ['electron-vite', 'build'], { stdio: 'inherit', env, shell: true })
if (build.status !== 0) process.exit(build.status ?? 1)

const electronPath = createRequire(import.meta.url)('electron')
const run = spawnSync(electronPath, ['.', '--seed-demo'], { stdio: 'inherit', env })
process.exit(run.status ?? 1)
