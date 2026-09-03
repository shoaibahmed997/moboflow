// AudioWorkletProcessor: runs off the main thread, resamples the mic's native sample
// rate down to the model's expected 16kHz via linear interpolation, and posts ~100ms
// PCM chunks + a throttled RMS level reading back to the main thread.
//
// Plain JS (not TS) and served from public/ so it loads via a stable absolute URL
// (`audioWorklet.addModule('/worklets/capture-processor.js')`) without depending on
// Vite's asset pipeline for worklet modules.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const targetSampleRate = options.processorOptions?.targetSampleRate ?? 16000
    this.ratio = sampleRate / targetSampleRate
    this.buffer = new Float32Array(0)
    this.readCursor = 0
    this.chunkTarget = Math.round(targetSampleRate * 0.1) // flush ~every 100ms of resampled audio
    this.outChunk = []
    this.levelCounter = 0
    this.levelEveryNCalls = Math.max(1, Math.round(sampleRate / 128 / 30)) // ~30 level updates/sec
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (channel && channel.length > 0) {
      const merged = new Float32Array(this.buffer.length + channel.length)
      merged.set(this.buffer)
      merged.set(channel, this.buffer.length)
      this.buffer = merged

      while (this.readCursor + 1 < this.buffer.length) {
        const idx = Math.floor(this.readCursor)
        const frac = this.readCursor - idx
        this.outChunk.push(this.buffer[idx] * (1 - frac) + this.buffer[idx + 1] * frac)
        this.readCursor += this.ratio
      }

      // Drop the fully-consumed prefix, keeping one sample of context for interpolation.
      const dropCount = Math.max(0, Math.floor(this.readCursor) - 1)
      if (dropCount > 0) {
        this.buffer = this.buffer.slice(dropCount)
        this.readCursor -= dropCount
      }

      if (this.outChunk.length >= this.chunkTarget) {
        const samples = Float32Array.from(this.outChunk)
        this.port.postMessage({ type: 'pcm', samples }, [samples.buffer])
        this.outChunk = []
      }

      this.levelCounter++
      if (this.levelCounter >= this.levelEveryNCalls) {
        this.levelCounter = 0
        let sumSq = 0
        for (let i = 0; i < channel.length; i++) sumSq += channel[i] * channel[i]
        this.port.postMessage({ type: 'level', rms: Math.sqrt(sumSq / channel.length) })
      }
    }
    return true
  }
}

registerProcessor('capture-processor', CaptureProcessor)
