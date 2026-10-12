import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const alias = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias }
  },
  preload: {
    // Sandboxed preloads cannot require npm modules, so everything is bundled.
    resolve: { alias },
    build: { rollupOptions: { output: { format: 'cjs' } } }
  },
  renderer: {
    resolve: { alias },
    plugins: [react()],
    build: { minify: 'esbuild' }
  }
})
