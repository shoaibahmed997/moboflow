// Log-mel feature extraction matching HF `ParakeetFeatureExtractor` (used to produce
// the training/export features for nvidia/parakeet-tdt-0.6b-v3) exactly: preemphasis
// -> centered STFT (Hann, zero-padded) -> librosa slaney mel filterbank -> log ->
// per-feature (per mel-bin) mean/variance normalization over the whole buffer.
//
// Verified against real `torch.stft` + `librosa.filters.mel` output on a synthetic
// signal: max abs error ~4.7e-5 on the final normalized features (float32 rounding
// noise). See parakeet/README.md and SPEC.md §6 Phase 3 for provenance.
//
// IMPORTANT: normalization is computed over the whole input buffer, not per-frame —
// this is why the ASR engine re-runs the full pipeline on each growing/finalized
// buffer rather than extracting features incrementally frame-by-frame.

export const SAMPLE_RATE = 16000
export const N_FFT = 512
export const HOP_LENGTH = 160
export const WIN_LENGTH = 400
export const N_MELS = 128
const PREEMPHASIS = 0.97
const LOG_ZERO_GUARD_VALUE = 2 ** -24
const NORM_EPSILON = 1e-5

function hannWindowPeriodicFalse(length: number): Float64Array {
  const w = new Float64Array(length)
  for (let n = 0; n < length; n++) w[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (length - 1))
  return w
}

function hzToMelSlaney(hz: number): number {
  const fSp = 200.0 / 3
  const minLogHz = 1000.0
  const minLogMel = minLogHz / fSp
  const logstep = Math.log(6.4) / 27.0
  if (hz < minLogHz) return hz / fSp
  return minLogMel + Math.log(hz / minLogHz) / logstep
}

function melToHzSlaney(mel: number): number {
  const fSp = 200.0 / 3
  const minLogHz = 1000.0
  const minLogMel = minLogHz / fSp
  const logstep = Math.log(6.4) / 27.0
  if (mel < minLogMel) return fSp * mel
  return minLogHz * Math.exp(logstep * (mel - minLogMel))
}

function buildMelFilterBank(sr: number, nFft: number, nMels: number, fMin: number, fMax: number): Float64Array[] {
  const nFreqs = Math.floor(nFft / 2) + 1
  const fftFreqs = Array.from({ length: nFreqs }, (_, i) => (i * sr) / nFft)
  const melMin = hzToMelSlaney(fMin)
  const melMax = hzToMelSlaney(fMax)
  const melPoints = Array.from({ length: nMels + 2 }, (_, i) => melMin + ((melMax - melMin) * i) / (nMels + 1))
  const hzPoints = melPoints.map(melToHzSlaney)
  const fdiff: number[] = []
  for (let i = 0; i < hzPoints.length - 1; i++) fdiff.push(hzPoints[i + 1] - hzPoints[i])

  const weights = Array.from({ length: nMels }, () => new Float64Array(nFreqs))
  for (let m = 0; m < nMels; m++) {
    for (let k = 0; k < nFreqs; k++) {
      const lower = -(hzPoints[m] - fftFreqs[k]) / fdiff[m]
      const upper = (hzPoints[m + 2] - fftFreqs[k]) / fdiff[m + 1]
      weights[m][k] = Math.max(0, Math.min(lower, upper))
    }
    const enorm = 2.0 / (hzPoints[m + 2] - hzPoints[m])
    for (let k = 0; k < nFreqs; k++) weights[m][k] *= enorm
  }
  return weights
}

// radix-2 in-place FFT; n must be a power of two (512 here)
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wRe = Math.cos(ang)
    const wIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j]
        const uIm = im[i + j]
        const vRe = re[i + j + len / 2] * curRe - im[i + j + len / 2] * curIm
        const vIm = re[i + j + len / 2] * curIm + im[i + j + len / 2] * curRe
        re[i + j] = uRe + vRe
        im[i + j] = uIm + vIm
        re[i + j + len / 2] = uRe - vRe
        im[i + j + len / 2] = uIm - vIm
        const nextRe = curRe * wRe - curIm * wIm
        const nextIm = curRe * wIm + curIm * wRe
        curRe = nextRe
        curIm = nextIm
      }
    }
  }
}

const hannWindow = hannWindowPeriodicFalse(WIN_LENGTH)
const melFilters = buildMelFilterBank(SAMPLE_RATE, N_FFT, N_MELS, 0, SAMPLE_RATE / 2)
const WIN_PAD = (N_FFT - WIN_LENGTH) / 2 // window centered inside the FFT buffer

function preemphasize(x: Float32Array): Float32Array {
  const y = new Float32Array(x.length)
  y[0] = x[0]
  for (let i = 1; i < x.length; i++) y[i] = x[i] - PREEMPHASIS * x[i - 1]
  return y
}

/**
 * Extracts normalized log-mel features from 16kHz mono PCM.
 * Returns a flat Float32Array in [mel, time] row-major order (matches the encoder's
 * `audio_signal` ONNX input layout [1, 128, numFrames]) plus the frame count.
 */
export function extractLogMelFeatures(pcm16k: Float32Array): { features: Float32Array; numFrames: number } {
  const pre = preemphasize(pcm16k)

  const pad = N_FFT >> 1
  const padded = new Float32Array(pre.length + 2 * pad)
  padded.set(pre, pad)
  const numFrames = Math.floor(pre.length / HOP_LENGTH) + 1
  const nFreqs = N_FFT / 2 + 1

  const power: Float64Array[] = Array.from({ length: nFreqs }, () => new Float64Array(numFrames))
  const re = new Float64Array(N_FFT)
  const im = new Float64Array(N_FFT)
  for (let f = 0; f < numFrames; f++) {
    re.fill(0)
    im.fill(0)
    const frameStart = f * HOP_LENGTH
    for (let n = 0; n < WIN_LENGTH; n++) {
      re[WIN_PAD + n] = padded[frameStart + WIN_PAD + n] * hannWindow[n]
    }
    fft(re, im)
    for (let k = 0; k < nFreqs; k++) power[k][f] = re[k] * re[k] + im[k] * im[k]
  }

  const logMel: Float64Array[] = Array.from({ length: N_MELS }, () => new Float64Array(numFrames))
  for (let m = 0; m < N_MELS; m++) {
    const filt = melFilters[m]
    for (let f = 0; f < numFrames; f++) {
      let sum = 0
      for (let k = 0; k < nFreqs; k++) sum += filt[k] * power[k][f]
      logMel[m][f] = Math.log(sum + LOG_ZERO_GUARD_VALUE)
    }
  }

  const features = new Float32Array(N_MELS * numFrames)
  for (let m = 0; m < N_MELS; m++) {
    let mean = 0
    for (let f = 0; f < numFrames; f++) mean += logMel[m][f]
    mean /= numFrames
    let variance = 0
    for (let f = 0; f < numFrames; f++) variance += (logMel[m][f] - mean) ** 2
    variance /= Math.max(1, numFrames - 1)
    const std = Math.sqrt(variance)
    const rowOffset = m * numFrames
    for (let f = 0; f < numFrames; f++) features[rowOffset + f] = (logMel[m][f] - mean) / (std + NORM_EPSILON)
  }

  return { features, numFrames }
}
