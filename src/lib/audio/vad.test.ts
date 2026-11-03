import { describe, expect, it } from 'vitest'
import { createEnergyVad, type SpeechSegmentTiming } from './vad'

const SAMPLE_RATE = 16000
const CHUNK = 1600 // 100ms, matching the capture worklet

const speech = () => new Float32Array(CHUNK).fill(0.1)
const silence = () => new Float32Array(CHUNK)

function record(options: Partial<Parameters<typeof createEnergyVad>[0]> = {}) {
  const segments: { length: number; timing: SpeechSegmentTiming }[] = []
  const vad = createEnergyVad({
    sampleRate: SAMPLE_RATE,
    onSpeechEnd: (pcm, timing) => segments.push({ length: pcm.length, timing }),
    ...options,
  })
  const push = (make: () => Float32Array, count: number) => {
    for (let i = 0; i < count; i++) vad.push(make())
  }
  return { vad, segments, push }
}

describe('createEnergyVad', () => {
  it('reports segment timing on the stream clock, excluding trailing hangover silence', () => {
    const { segments, push } = record()
    push(silence, 5) // 0–500ms
    push(speech, 10) // 500–1500ms
    push(silence, 6) // 600ms hangover → finalize
    push(silence, 4)
    push(speech, 5) // 2500–3000ms
    push(silence, 6)

    expect(segments.map((s) => s.timing)).toEqual([
      { startSample: 0.5 * SAMPLE_RATE, endSample: 1.5 * SAMPLE_RATE },
      { startSample: 2.5 * SAMPLE_RATE, endSample: 3 * SAMPLE_RATE },
    ])
  })

  it('flush() finalizes in-progress speech with timing; reset() restarts the clock', () => {
    const { vad, segments, push } = record()
    push(silence, 2)
    push(speech, 4)
    vad.flush()
    expect(segments[0].timing).toEqual({ startSample: 3200, endSample: 3200 + 4 * CHUNK })

    vad.reset()
    push(speech, 4)
    vad.flush()
    expect(segments[1].timing.startSample).toBe(0)
  })

  it('discards false starts shorter than minSpeechMs', () => {
    const { vad, segments, push } = record()
    push(speech, 1)
    push(silence, 10)
    vad.flush()
    expect(segments).toHaveLength(0)
  })

  it('cuts pause-free speech at the next dip after maxSegmentMs', () => {
    const { segments, push } = record({ maxSegmentMs: 1000 })
    push(speech, 12)
    // A dip below speechThreshold but above silenceThreshold: not a pause, but a safe cut point.
    push(() => new Float32Array(CHUNK).fill(0.015), 1)
    expect(segments).toHaveLength(1)
    expect(segments[0].timing).toEqual({ startSample: 0, endSample: 13 * CHUNK })
  })

  it('hard-cuts at 1.5× maxSegmentMs when there is no dip', () => {
    const { segments, push } = record({ maxSegmentMs: 1000 })
    push(speech, 20)
    expect(segments.map((s) => s.length)).toEqual([15 * CHUNK])
  })
})
