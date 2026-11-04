// Real transcription (Chromium only: it's the browser that can feed a speech file as
// the microphone). Covers the offline matrix's model-cached half plus the two
// data-loss paths hardened in Phase 9: engine load failure and a full storage quota.
// Every test starts from a fresh context, so the model downloads from the local
// preview server first (~890MB, a few seconds).
import { expect, test, type Page } from '@playwright/test'
import { HAS_MODEL, openControlled, readDb, waitForDb } from './helpers'

test.skip(({ browserName }) => browserName !== 'chromium', 'needs a speech file as the fake microphone (Chromium only)')
test.skip(!HAS_MODEL, 'parakeet/ model not present (git-ignored; see parakeet/README.md)')
test.setTimeout(300_000)

const startRecording = (page: Page) => page.getByRole('button', { name: 'Start recording' }).click()
const stopRecording = (page: Page) => page.getByRole('button', { name: 'Stop and save' }).click()

/** Counts finals the worker decoded (it logs one line per final). */
function countDecodes(page: Page) {
  const counter = { decoded: 0 }
  page.on('console', (msg) => {
    if (msg.text().startsWith('[asr worker] decoded')) counter.decoded++
  })
  return counter
}

test('records and transcribes fully offline once the model has been downloaded', async ({ page, context }) => {
  await openControlled(page)

  // Online, first run: downloads the model and caches the ORT runtime.
  await startRecording(page)
  await waitForDb(page, (db) => db.segments.length >= 1)
  await stopRecording(page)
  await waitForDb(page, (db) => db.sessions.every((s) => s.status === 'complete'))
  const cached = await page.evaluate(async () => ({
    runtime: (await (await caches.open('ort-runtime')).keys()).length,
    model: await caches.has('moboflow-parakeet-tdt-0.6b-v3-int8'),
  }))
  expect(cached).toEqual({ runtime: 2, model: true })

  // Cold start with no network: shell from the SW, runtime + weights from Cache API.
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('status').filter({ hasText: 'Offline' })).toBeVisible()
  const before = (await readDb(page)).segments.length
  await startRecording(page)
  const db = await waitForDb(page, (snapshot) => snapshot.segments.length > before)
  await stopRecording(page)
  expect(db.segments.at(-1)?.text).toMatch(/fox|Moboflow|device/i)
  await waitForDb(page, (snapshot) => snapshot.sessions.length === 2 && snapshot.sessions.every((s) => s.status === 'complete'))
})

test('speech recorded while the engine cannot load is kept, then transcribed on retry', async ({ page, context }) => {
  const decodes = countDecodes(page)
  await openControlled(page)
  // The model download fails (server unreachable for model files only).
  await context.route('**/models/**', (route) => route.abort('connectionfailed'))

  await startRecording(page)
  await expect(page.getByText(/Transcription engine error/)).toBeVisible()
  await expect(page.getByText(/recorded but not transcribed yet/)).toBeVisible({ timeout: 30_000 })
  await stopRecording(page)
  await expect(page.getByText('Finishing transcription — saving shortly…')).toBeVisible()
  const heldBanner = await page.getByText(/recorded but not transcribed yet/).innerText()
  const held = Number(/(\d+) passage/.exec(heldBanner)?.[1] ?? 1)
  expect((await readDb(page)).segments).toHaveLength(0)

  // Model server back → Retry: every held passage is transcribed and saved.
  await context.unroute('**/models/**')
  await page.getByRole('button', { name: 'Retry' }).click()
  const db = await waitForDb(page, (snapshot) => snapshot.sessions[0]?.status === 'complete')
  expect(db.segments.length).toBeGreaterThanOrEqual(held)
  expect(db.segments.length).toBe(decodes.decoded)
  await expect(page.getByText(/recorded but not transcribed yet/)).toBeHidden()
})

test('sentences survive a full storage quota and are saved once space frees up', async ({ page }) => {
  // Simulate IndexedDB quota exhaustion for transcript writes, switchable from the test.
  await page.addInitScript(() => {
    const w = window as unknown as { __quotaFull: boolean }
    w.__quotaFull = false
    for (const method of ['add', 'put'] as const) {
      const original = IDBObjectStore.prototype[method]
      IDBObjectStore.prototype[method] = function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
        if (w.__quotaFull && this.name === 'segments') throw new DOMException('Simulated quota', 'QuotaExceededError')
        return original.apply(this, args)
      } as typeof original
    }
  })
  const decodes = countDecodes(page)
  await openControlled(page)

  await startRecording(page)
  await waitForDb(page, (db) => db.segments.length >= 1) // engine is up
  await page.evaluate(() => ((window as unknown as { __quotaFull: boolean }).__quotaFull = true))
  await expect(page.getByText(/Storage is full — \d+ sentences? ha/)).toBeVisible({ timeout: 60_000 })
  await stopRecording(page)
  const savedWhileFull = (await readDb(page)).segments.length
  expect(decodes.decoded).toBeGreaterThan(savedWhileFull)

  await page.evaluate(() => ((window as unknown as { __quotaFull: boolean }).__quotaFull = false))
  const db = await waitForDb(page, (snapshot) => snapshot.sessions[0]?.status === 'complete', 30_000)
  expect(db.segments.length).toBe(decodes.decoded) // nothing lost
  await expect(page.getByText(/Storage is full/)).toBeHidden()
})
