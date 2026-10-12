import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * W9.6: builds the agent's React renderer (the real `AssetsPage` from `web/src/features/assets`,
 * not a reimplementation) into static files `agent/main/security.ts`'s `registerAppProtocol` can
 * serve -- same custom-scheme + CSP approach as the rest of the shell, no dev server or remote
 * origin involved. Mirrors `web/vite.config.ts`'s own `@shared` alias exactly.
 */
export default defineConfig({
  root: resolve(__dirname),
  resolve: { alias: { '@shared': resolve(__dirname, '../../src/shared') } },
  plugins: [react()],
  build: { outDir: resolve(__dirname, '../out/renderer'), emptyOutDir: true, sourcemap: false, minify: 'esbuild' }
})
