import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { execFileSync } from 'child_process'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), {
      name: 'notes-selection-helper',
      buildStart() {
        this.addWatchFile(resolve(__dirname, 'electron/notes/selection-helper.cs'))
        this.addWatchFile(resolve(__dirname, 'scripts/build-note-selection.cjs'))
      },
      closeBundle() {
        execFileSync(process.execPath, [resolve(__dirname, 'scripts/build-note-selection.cjs')], { stdio: 'inherit', windowsHide: true, timeout: 35000 })
      }
    }],
    build: {
      rollupOptions: {
        input: { main: resolve(__dirname, 'electron/main.ts'), 'database-worker': resolve(__dirname, 'electron/database-worker.ts') },
        output: { entryFileNames: '[name].js' }
      }
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
