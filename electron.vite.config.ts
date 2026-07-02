import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// electron-vite convention:
//   src/main    -> Electron main process (Node context, deps externalized so
//                  native modules like better-sqlite3 are require()d, not bundled)
//   src/preload -> context-isolated bridge
//   src/renderer-> React app (bundled by Vite, so react/zustand can live in devDeps)
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react()]
  }
})
