import { defineConfig } from 'vitest/config'

// Kept separate from vite.config.ts so unit tests don't spin up the PWA plugin or the
// dev-only model/ORT asset servers.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
