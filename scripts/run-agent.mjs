// Launches the bundled W9.3 agent shell. Same ELECTRON_RUN_AS_NODE cleanup as run-electron.mjs --
// editors such as VS Code export it, which would make Electron run as plain Node.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn('npx', ['electron', join(root, 'agent/out/main/index.js'), ...process.argv.slice(2)], { stdio: 'inherit', env, shell: true })
child.on('exit', (code) => process.exit(code ?? 1))
