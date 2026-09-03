import { useCallback, useEffect, useRef, useState } from 'react'
import { createEnergyVad, type VadHandle } from './vad'

export type MicCaptureStatus = 'idle' | 'requesting' | 'active' | 'error'

const TARGET_SAMPLE_RATE = 16000

interface UseMicCaptureOptions {
  /** Called with the full utterance PCM (16kHz mono) once the VAD confirms silence. */
  onSegment?: (pcm: Float32Array) => void
  /** Called periodically with the growing in-progress utterance, for partial/streaming decode. */
  onPartial?: (pcm: Float32Array) => void
}

export function useMicCapture({ onSegment, onPartial }: UseMicCaptureOptions = {}) {
  const [status, setStatus] = useState<MicCaptureStatus>('idle')
  const [level, setLevel] = useState(0)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const audioContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const workletNodeRef = useRef<AudioWorkletNode | null>(null)

  // Keep latest callbacks in refs so the VAD (constructed once on mount) and the
  // worklet's message handler always call the current versions, not stale closures.
  const onSegmentRef = useRef(onSegment)
  const onPartialRef = useRef(onPartial)
  useEffect(() => {
    onSegmentRef.current = onSegment
    onPartialRef.current = onPartial
  }, [onSegment, onPartial])

  const vadRef = useRef<VadHandle | null>(null)
  if (vadRef.current === null) {
    vadRef.current = createEnergyVad({
      sampleRate: TARGET_SAMPLE_RATE,
      onSpeechEnd: (pcm) => onSegmentRef.current?.(pcm),
      onPartial: (pcm) => onPartialRef.current?.(pcm),
    })
  }

  const stop = useCallback(() => {
    workletNodeRef.current?.port.close()
    workletNodeRef.current?.disconnect()
    workletNodeRef.current = null

    for (const track of streamRef.current?.getTracks() ?? []) track.stop()
    streamRef.current = null

    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      void audioContextRef.current.close()
    }
    audioContextRef.current = null

    vadRef.current?.flush()
    setStatus('idle')
    setLevel(0)
    setIsSpeaking(false)
  }, [])

  const start = useCallback(async () => {
    setError(null)
    setStatus('requesting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      streamRef.current = stream

      const audioContext = new AudioContext()
      audioContextRef.current = audioContext
      await audioContext.audioWorklet.addModule('/worklets/capture-processor.js')

      const source = audioContext.createMediaStreamSource(stream)
      const workletNode = new AudioWorkletNode(audioContext, 'capture-processor', {
        processorOptions: { targetSampleRate: TARGET_SAMPLE_RATE },
        numberOfOutputs: 1,
        outputChannelCount: [1],
      })
      workletNodeRef.current = workletNode

      // Some browsers only pump AudioWorklet processing while the graph reaches an
      // active destination; route through a silent gain node so it can't be heard.
      const muteGain = audioContext.createGain()
      muteGain.gain.value = 0
      source.connect(workletNode)
      workletNode.connect(muteGain)
      muteGain.connect(audioContext.destination)

      vadRef.current?.reset()
      workletNode.port.onmessage = (event: MessageEvent) => {
        const msg = event.data
        if (msg.type === 'level') {
          setLevel(Math.min(1, msg.rms * 6)) // rough scaling for a 0..1 meter
        } else if (msg.type === 'pcm') {
          vadRef.current?.push(msg.samples as Float32Array)
          setIsSpeaking(vadRef.current?.state === 'speech')
        }
      }

      setStatus('active')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Microphone access failed')
      setStatus('error')
      stop()
    }
  }, [stop])

  useEffect(() => {
    return () => stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { status, level, isSpeaking, error, start, stop }
}
