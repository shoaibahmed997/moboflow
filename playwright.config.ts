import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

// End-to-end tests run against the *production* build (`vite preview`), since that's
// where the service worker, precache and offline behaviour live. The preview server
// also serves the local, git-ignored parakeet/ model (vite.config.ts), so specs that
// need real transcription skip themselves when it's absent — see e2e/helpers.ts.

const PORT = 4173
const SPEECH_WAV = fileURLToPath(new URL('./e2e/fixtures/speech-en.wav', import.meta.url))

export default defineConfig({
  testDir: './e2e',
  // Specs share one preview server but each test gets its own browser context
  // (fresh IndexedDB/Cache API), so they're independent; a single worker keeps the
  // ~890MB model loads from competing for memory.
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm build && pnpm preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['microphone'],
        launchOptions: {
          // A real speech file as the microphone — the whole pipeline runs for real.
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            `--use-file-for-fake-audio-capture=${SPEECH_WAV}`,
          ],
        },
      },
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: {
          // Fake device (a tone, not speech) + auto-granted permission.
          firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true },
        },
      },
    },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    {
      // Mobile Safari viewport/UA on WebKit — the closest local proxy for iPhone.
      name: 'mobile-webkit',
      use: { ...devices['iPhone 15'] },
      testMatch: /app\.spec\.ts/,
    },
  ],
})
