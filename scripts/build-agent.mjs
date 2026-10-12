// Bundles the agent's main/preload into plain CJS with esbuild (Electron loads them directly), and
// builds the real React renderer (W9.6: the actual AssetsPage from web/src, via Vite) into static
// files `registerAppProtocol` serves. Mirrors run-electron.mjs's smallest-possible-script approach.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'
import { build as viteBuild } from 'vite'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'agent', 'out')
// esbuild doesn't read tsconfig `paths` on its own; `agent/validation.ts` imports `@shared/*`
// (reused Zod enums), so both bundles need the same alias `web/vite.config.ts`/`electron.vite.config.ts`
// already declare for the same path. Found by actually running this build, not assumed to work.
const alias = { '@shared': join(root, 'src/shared') }

await esbuild.build({
  entryPoints: [join(root, 'agent/main/index.ts')],
  outfile: join(outDir, 'main/index.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  alias,
  external: ['electron', 'better-sqlite3']
})

await esbuild.build({
  entryPoints: [join(root, 'agent/preload/index.ts')],
  outfile: join(outDir, 'preload/index.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  alias,
  external: ['electron']
})

await viteBuild({ configFile: join(root, 'agent/renderer-src/vite.config.ts') })

console.log(`Agent bundled -> ${outDir}`)
