// Runs the packaged app in --smoke-test mode against a throwaway data folder and
// prints the report. Usage: npm run package:dir && npm run smoke:packaged [path-to-exe]
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const exe = resolve(process.argv[2] ?? 'release/win-unpacked/BPOAssetManagement.exe')
if (!existsSync(exe)) {
  console.error(`Packaged executable not found: ${exe}\nRun "npm run package:dir" first.`)
  process.exit(2)
}

const dataDir = mkdtempSync(join(tmpdir(), 'bpoam-smoke-'))
const report = join(dataDir, 'smoke-report.json')
const env = { ...process.env, BPOAM_DATA_DIR: join(dataDir, 'data') }
delete env.ELECTRON_RUN_AS_NODE

const run = spawnSync(exe, ['--smoke-test', `--smoke-report=${report}`], { env, timeout: 120_000, stdio: 'inherit' })
if (!existsSync(report)) {
  console.error(`No smoke report produced (exit ${run.status}, signal ${run.signal}).`)
  process.exit(1)
}
const result = JSON.parse(readFileSync(report, 'utf8'))
for (const c of result.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`)
console.log(result.ok ? 'Packaged smoke test passed.' : 'Packaged smoke test FAILED.')
rmSync(dataDir, { recursive: true, force: true })
process.exit(result.ok && run.status === 0 ? 0 : 1)
