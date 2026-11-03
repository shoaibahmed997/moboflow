// Energy-based VAD (spec's fallback option — see SPEC.md §3/§6 Phase 2). Segments a
// continuous 16kHz PCM stream into speech utterances using hysteresis (separate
// speech/silence thresholds) and a hangover window so brief dips mid-sentence don't
// split one utterance in two.

/** Sample offsets are relative to the first sample pushed since the last `reset()`. */
export interface SpeechSegmentTiming {
  startSample: number
  /** Excludes the trailing hangover silence, so gaps between segments reflect real pauses. */
  endSample: number
}

export interface VadOptions {
  sampleRate: number
  /** RMS above this starts a speech candidate. */
  speechThreshold?: number
  /** RMS below this (sustained) ends speech. Must be < speechThreshold (hysteresis). */
  silenceThreshold?: number
  /** How long RMS must stay below silenceThreshold before an utterance is finalized. */
  hangoverMs?: number
  /** Minimum speech duration before onSpeechStart fires (filters clicks/pops). */
  minSpeechMs?: number
  /** Emits a growing-buffer snapshot at this interval while speech is ongoing, for partial/streaming decode. */
  partialIntervalMs?: number
  /**
   * Soft cap on utterance length. Past it, the segment is cut at the next energy dip
   * (or unconditionally at 1.5× the cap) so a pause-free monologue still gets finalized
   * — and persisted — regularly, and re-decode cost stays bounded.
   */
  maxSegmentMs?: number
  onSpeechStart?: () => void
  onPartial?: (pcm: Float32Array) => void
  /** Fires with the full utterance PCM once silence is confirmed. */
  onSpeechEnd?: (pcm: Float32Array, timing: SpeechSegmentTiming) => void
}

export function createEnergyVad(options: VadOptions) {
  const {
    sampleRate,
    speechThreshold = 0.02,
    silenceThreshold = 0.012,
    hangoverMs = 600,
    minSpeechMs = 150,
    partialIntervalMs = 1500,
    maxSegmentMs = 30_000,
    onSpeechStart,
    onPartial,
    onSpeechEnd,
  } = options

  let state: 'silence' | 'candidate' | 'speech' = 'silence'
  let segment: Float32Array[] = []
  let segmentLength = 0
  let segmentStartSample = 0
  let candidateSamples = 0
  let silenceSamples = 0
  let samplesSinceLastPartial = 0
  let totalSamples = 0

  const hangoverSamples = Math.round((hangoverMs / 1000) * sampleRate)
  const minSpeechSamples = Math.round((minSpeechMs / 1000) * sampleRate)
  const partialIntervalSamples = Math.round((partialIntervalMs / 1000) * sampleRate)
  const maxSegmentSamples = Math.round((maxSegmentMs / 1000) * sampleRate)

  function flattenSegment(): Float32Array {
    const out = new Float32Array(segmentLength)
    let offset = 0
    for (const chunk of segment) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    return out
  }

  /** Back to silence, discarding the in-progress segment but keeping the stream clock. */
  function clearSegment() {
    state = 'silence'
    segment = []
    segmentLength = 0
    candidateSamples = 0
    silenceSamples = 0
    samplesSinceLastPartial = 0
  }

  function emitSegment() {
    const pcm = flattenSegment()
    const timing = {
      startSample: segmentStartSample,
      endSample: segmentStartSample + segmentLength - silenceSamples,
    }
    clearSegment()
    onSpeechEnd?.(pcm, timing)
  }

  function reset() {
    clearSegment()
    totalSamples = 0
  }

  function rms(chunk: Float32Array): number {
    let sumSq = 0
    for (let i = 0; i < chunk.length; i++) sumSq += chunk[i] * chunk[i]
    return Math.sqrt(sumSq / chunk.length)
  }

  function push(chunk: Float32Array) {
    const chunkStart = totalSamples
    totalSamples += chunk.length
    const energy = rms(chunk)

    if (state === 'silence') {
      if (energy >= speechThreshold) {
        state = 'candidate'
        candidateSamples = chunk.length
        segment = [chunk]
        segmentLength = chunk.length
        segmentStartSample = chunkStart
      }
      return
    }

    if (state === 'candidate') {
      segment.push(chunk)
      segmentLength += chunk.length
      if (energy < silenceThreshold) {
        // dropped back to silence before confirming — discard the false start
        clearSegment()
        return
      }
      candidateSamples += chunk.length
      if (candidateSamples >= minSpeechSamples) {
        state = 'speech'
        samplesSinceLastPartial = 0
        onSpeechStart?.()
      }
      return
    }

    // state === 'speech'
    segment.push(chunk)
    segmentLength += chunk.length
    samplesSinceLastPartial += chunk.length

    if (energy < silenceThreshold) {
      silenceSamples += chunk.length
      if (silenceSamples >= hangoverSamples) {
        emitSegment()
        return
      }
    } else {
      silenceSamples = 0
    }

    if (
      segmentLength >= maxSegmentSamples &&
      (energy < speechThreshold || segmentLength >= maxSegmentSamples * 1.5)
    ) {
      emitSegment()
      return
    }

    if (samplesSinceLastPartial >= partialIntervalSamples) {
      samplesSinceLastPartial = 0
      onPartial?.(flattenSegment())
    }
  }

  /** Force-finalize any in-progress utterance (e.g. when the user taps stop). */
  function flush() {
    if (state === 'speech' && segmentLength > 0) emitSegment()
    else clearSegment()
  }

  return { push, flush, reset, get state() { return state } }
}

export type VadHandle = ReturnType<typeof createEnergyVad>
