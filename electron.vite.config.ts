import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: resolve(__dirname, 'electron/main.ts') }
    },
    resolve: { alias: { '@shared': resolve('shared') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: resolve(__dirname, 'electron/preload.ts') }
    },
    resolve: { alias: { '@shared': resolve('shared') } }
  },
  renderer: {
    root: 'src',
    plugins: [react()],
    build: {
      rollupOptions: { input: resolve('src/index.html') }
    },
    resolve: { alias: { '@shared': resolve('shared') } }
  }
})
