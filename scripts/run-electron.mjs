// Launches electron-vite with a clean environment. Editors such as VS Code export
// ELECTRON_RUN_AS_NODE=1, which would make Electron run as plain Node and fail.
import { spawn } from 'node:child_process'

const mode = process.argv[2] ?? 'dev'
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn('npx', ['electron-vite', mode, ...process.argv.slice(3)], { stdio: 'inherit', env, shell: true })
child.on('exit', (code) => process.exit(code ?? 1))
