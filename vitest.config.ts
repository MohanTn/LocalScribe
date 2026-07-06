import { defineConfig } from 'vitest/config'

// Main-process code runs under Node, not a browser/DOM — no jsdom needed.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/main/**/*.test.ts', 'scripts/**/*.test.mjs']
  }
})
