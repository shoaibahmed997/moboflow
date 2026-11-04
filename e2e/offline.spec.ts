// Offline matrix, part 1 (every browser): cold start offline, saved sessions readable
// offline, and a clean refusal — no half-created session — when recording offline
// before the model was ever downloaded. Part 2 (model cached) is in asr.spec.ts.
import { expect, test } from '@playwright/test'
import { openControlled, readDb, seed } from './helpers'

test('app shell and saved sessions work after a cold start offline', async ({ page, context }) => {
  await openControlled(page, '/sessions')
  await seed(page, [{ id: 'notes', title: 'Offline notes', segments: [[0, 2000, 'written while online']] }])

  await context.setOffline(true)
  await page.goto('/sessions/notes') // full navigation, served by the service worker
  await expect(page.getByText('Written while online.')).toBeVisible()

  await page.getByRole('link', { name: 'Record' }).click()
  await expect(page.getByRole('heading', { name: 'Moboflow' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'Offline' })).toBeVisible()
  await page.getByRole('link', { name: 'Sessions' }).click()
  await expect(page.getByRole('link', { name: /Offline notes/ })).toBeVisible()
})

test('recording offline without the model is refused up front, creating nothing', async ({ page, context }) => {
  await openControlled(page, '/')
  await context.setOffline(true)
  await page.reload()

  await page.getByRole('button', { name: 'Start recording' }).click()
  await expect(page.getByText(/You're offline, and the transcription model isn't downloaded/)).toBeVisible()
  await expect(page.getByText('Tap to start')).toBeVisible()
  expect((await readDb(page)).sessions).toHaveLength(0)
})
