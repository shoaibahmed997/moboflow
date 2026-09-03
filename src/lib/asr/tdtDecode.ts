import type * as Ort from 'onnxruntime-web/wasm'
import { BLANK_ID, DURATIONS, JOINT_OUTPUT_SIZE, VOCAB_SIZE } from './tokenizer'

const DECODER_LAYERS = 2
const DECODER_HIDDEN = 640
const MAX_SYMBOLS_PER_STEP = 10 // from nvidia/parakeet-tdt-0.6b-v3 config.json

interface DecoderState {
  h: Float32Array // [2, 1, 640]
  c: Float32Array // [2, 1, 640]
}

function zeroState(): DecoderState {
  return {
    h: new Float32Array(DECODER_LAYERS * DECODER_HIDDEN),
    c: new Float32Array(DECODER_LAYERS * DECODER_HIDDEN),
  }
}

/**
 * Greedy TDT (Token-and-Duration Transducer) decoding for a single utterance.
 *
 * Ported directly from NeMo's `GreedyTDTInfer._greedy_decode` (rnnt_greedy_decoding.py):
 * at each encoder time step, repeatedly query the fused decoder+joint network with the
 * last emitted token (or the blank id as the initial SOS) and the current LSTM state;
 * a predicted token is emitted (unless blank) and the predicted duration always advances
 * time — whether or not a token was emitted — capped by `max_symbols_per_step` per frame
 * with a duration=0 fallback to force one frame of progress. See SPEC.md §6 Phase 3 for
 * provenance notes.
 */
export async function greedyTdtDecode(
  ort: typeof Ort,
  decoderJointSession: Ort.InferenceSession,
  encoderOutput: Float32Array, // [1024, encTime], row-major (feature, time)
  encTime: number,
): Promise<number[]> {
  const tokens: number[] = []
  let state = zeroState()
  let lastToken = BLANK_ID // SOS convention: prime the predictor with the blank id
  let timeIdx = 0

  while (timeIdx < encTime) {
    let symbolsAdded = 0
    let duration = 0
    let needLoop = true

    while (needLoop && symbolsAdded < MAX_SYMBOLS_PER_STEP) {
      const encFrame = new Float32Array(1024)
      for (let d = 0; d < 1024; d++) encFrame[d] = encoderOutput[d * encTime + timeIdx]

      const feeds: Record<string, Ort.Tensor> = {
        encoder_outputs: new ort.Tensor('float32', encFrame, [1, 1024, 1]),
        targets: new ort.Tensor('int32', Int32Array.from([lastToken]), [1, 1]),
        target_length: new ort.Tensor('int32', Int32Array.from([1]), [1]),
        input_states_1: new ort.Tensor('float32', state.h, [DECODER_LAYERS, 1, DECODER_HIDDEN]),
        input_states_2: new ort.Tensor('float32', state.c, [DECODER_LAYERS, 1, DECODER_HIDDEN]),
      }

      const results = await decoderJointSession.run(feeds)
      const logits = results.outputs.data as Float32Array // [1,1,1,JOINT_OUTPUT_SIZE]

      let bestToken = 0
      let bestScore = -Infinity
      for (let v = 0; v < VOCAB_SIZE; v++) {
        if (logits[v] > bestScore) {
          bestScore = logits[v]
          bestToken = v
        }
      }

      let bestDurIdx = 0
      let bestDurScore = -Infinity
      for (let d = 0; d < DURATIONS.length; d++) {
        const score = logits[VOCAB_SIZE + d]
        if (score > bestDurScore) {
          bestDurScore = score
          bestDurIdx = d
        }
      }
      duration = DURATIONS[bestDurIdx]

      if (bestToken !== BLANK_ID) {
        tokens.push(bestToken)
        lastToken = bestToken
        state = {
          h: results.output_states_1.data as Float32Array,
          c: results.output_states_2.data as Float32Array,
        }
      }

      symbolsAdded += 1
      timeIdx += duration
      needLoop = duration === 0
    }

    // Loop exited on the symbol budget with duration still 0 — force one frame of
    // progress so we can never stall (matches the reference's post-loop `skip=1` fallback).
    if (duration === 0) {
      timeIdx += 1
    }
  }

  return tokens
}

export { JOINT_OUTPUT_SIZE }
