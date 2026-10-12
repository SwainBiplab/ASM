import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Browser application (W3). In development the Vite server proxies `/api` to the Fastify API so
 * the browser sees one origin; set PUBLIC_ORIGIN=http://localhost:5173 on the API to match.
 * In production the API serves the built files itself (same origin, no CORS).
 */
export default defineConfig({
  root: resolve(__dirname),
  resolve: { alias: { '@shared': resolve(__dirname, '../src/shared') } },
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: process.env['API_PROXY_TARGET'] ?? 'http://127.0.0.1:3000', changeOrigin: false } }
  },
  build: { outDir: resolve(__dirname, 'dist'), emptyOutDir: true, sourcemap: false, minify: 'esbuild' }
})
