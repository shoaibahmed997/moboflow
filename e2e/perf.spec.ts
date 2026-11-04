// Transcription speed (real-time factor = compute time / audio time; < 1 keeps up with
// speech), on this machine and under 4× CPU throttling as a rough proxy for a low-end
// phone. Reports numbers as test annotations rather than asserting device-dependent
// thresholds — real-device runs remain the source of truth (docs/browser-support.md).
import { expect, test, type Page } from '@playwright/test'
import { HAS_MODEL, waitForDb } from './helpers'

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium only (fake speech mic + CDP throttling)')
test.skip(!HAS_MODEL, 'parakeet/ model not present')
test.setTimeout(300_000)

async function measure(page: Page, utterances: number): Promise<number[]> {
  const rtfs: number[] = []
  page.on('console', (msg) => {
    const match = /\(RTF ([\d.]+)\)/.exec(msg.text())
    if (match) rtfs.push(Number(match[1]))
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Start recording' }).click()
  await expect.poll(() => rtfs.length, { timeout: 240_000, intervals: [500] }).toBeGreaterThanOrEqual(utterances)
  await page.getByRole('button', { name: 'Stop and save' }).click()
  await waitForDb(page, (db) => db.sessions.every((s) => s.status === 'complete'))
  return rtfs
}

const summary = (rtfs: number[]) => {
  const sorted = [...rtfs].sort((a, b) => a - b)
  return `n=${rtfs.length} median RTF ${sorted[Math.floor(sorted.length / 2)].toFixed(3)} (min ${sorted[0].toFixed(3)}, max ${sorted.at(-1)!.toFixed(3)})`
}

test('real-time factor: desktop vs 4× CPU throttle', async ({ page }, testInfo) => {
  const desktop = await measure(page, 4)
  testInfo.annotations.push({ type: 'RTF desktop', description: summary(desktop) })

  // Throttle every target the page owns, including the ASR worker.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  const throttled = await measure(page, 4)
  testInfo.annotations.push({ type: 'RTF 4× throttled', description: summary(throttled) })
  console.log(`desktop: ${summary(desktop)}\n4× throttle: ${summary(throttled)}`)

  expect(Math.max(...desktop)).toBeLessThan(1) // must keep up with speech on a desktop
})
