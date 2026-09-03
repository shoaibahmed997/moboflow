// SentencePiece-style detokenizer for the Parakeet vocab (id -> token, "▁" marks a
// word boundary/leading space). vocab.txt is `<token> <id>` per line, one entry per id
// in order — see parakeet/vocab.txt.

export const BLANK_ID = 8192
export const VOCAB_SIZE = 8193
export const NUM_DURATIONS = 5
export const DURATIONS = [0, 1, 2, 3, 4]
export const JOINT_OUTPUT_SIZE = VOCAB_SIZE + NUM_DURATIONS // 8198

export interface Tokenizer {
  idToToken: string[]
  /** Renders a sequence of emitted (non-blank) token ids as text. */
  decode: (ids: number[]) => string
}

export function parseVocab(vocabText: string): Tokenizer {
  const idToToken: string[] = []
  for (const line of vocabText.split('\n')) {
    if (!line) continue
    const sep = line.lastIndexOf(' ')
    if (sep === -1) continue
    const token = line.slice(0, sep)
    const id = Number(line.slice(sep + 1))
    idToToken[id] = token
  }

  function decode(ids: number[]): string {
    let out = ''
    for (const id of ids) {
      const token = idToToken[id]
      if (token === undefined) continue
      // Special/control tokens (language tags, <unk>/<pad>/<blk>, etc.) are wrapped in
      // angle brackets and never real word pieces — skip them if the model ever emits one.
      if (token.startsWith('<') && token.endsWith('>')) continue
      out += token.startsWith('▁') ? ' ' + token.slice(1) : token
    }
    return out.replace(/^ /, '')
  }

  return { idToToken, decode }
}
