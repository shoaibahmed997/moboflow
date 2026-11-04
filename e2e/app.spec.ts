// Core flows that need no microphone or model, so they run on every browser project:
// browse, search, edit with undo, export, and the Device & storage dialog.
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { readDb, seed } from './helpers'

test.beforeEach(async ({ page }) => {
  await page.goto('/sessions')
  await expect(page.getByText('No transcripts yet')).toBeVisible() // also creates the DB schema
  await seed(page, [
    {
      id: 'roadmap',
      title: 'Roadmap sync',
      tags: ['work'],
      segments: [
        [0, 2500, 'um so i wanted to talk about the roadmap'],
        [3200, 6000, 'uh the first thing is , we need better onboarding'],
        [9500, 12000, 'second topic. pricing is still open'],
      ],
    },
    { id: 'groceries', title: 'Errands', segments: [[0, 2000, 'buy apples and bananas']] },
  ])
})

test('search finds a session by its transcript and highlights the match', async ({ page }) => {
  await expect(page.getByRole('link', { name: /Roadmap sync/ })).toBeVisible()
  await page.getByRole('searchbox', { name: 'Search sessions' }).fill('onboard')
  await expect(page.locator('ul > li')).toHaveCount(1)
  await expect(page.locator('mark', { hasText: 'onboarding' })).toBeVisible()
})

test('formatted transcript can be edited, undone and exported', async ({ page }) => {
  await page.goto('/sessions/roadmap')
  await expect(page.getByText('So I wanted to talk about the roadmap.')).toBeVisible()

  await page.getByRole('button', { name: 'The first thing is, we need better onboarding.' }).click()
  const editor = page.getByRole('textbox', { name: 'Edit sentence' })
  await editor.fill('First, we need better onboarding.')
  await editor.press('Enter')
  await expect(page.getByText('First, we need better onboarding.')).toBeVisible()
  await expect.poll(async () => (await readDb(page)).segments.find((s) => s.id === 'roadmap-1')?.isEdited).toBe(true)

  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByText('The first thing is, we need better onboarding.')).toBeVisible()
  await expect.poll(async () => (await readDb(page)).segments.find((s) => s.id === 'roadmap-1')?.isEdited).toBe(false)

  await page.getByRole('button', { name: 'Export ▾' }).click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: /Download \.md/ }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(/^Roadmap sync \d{4}-\d{2}-\d{2}\.md$/)
  const markdown = readFileSync((await download.path())!, 'utf8')
  expect(markdown).toContain('# Roadmap sync')
  expect(markdown).toContain('#work')
  expect(markdown).toContain('So I wanted to talk about the roadmap. The first thing is, we need better onboarding.')
})

test('Device & storage dialog reports storage and engine state', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Device & storage' }).click()
  const dialog = page.getByRole('dialog', { name: 'Device & storage' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(/MB of .* available to this app/)).toBeVisible()
  await expect(dialog.getByText('Not downloaded — downloads when you first record')).toBeVisible()
  await expect(dialog.getByText(/Not loaded yet/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()
})
