# Moboflow

Let your thoughts flow into your mobile — an installable PWA for on-device voice transcription.

## Status

Phases 1–5 complete: installable PWA shell, mic capture + VAD, on-device Parakeet transcription, session persistence (pause/resume, autosave, crash recovery, rename/delete), and transcript editing (auto-formatting, paragraphs, inline edits with undo/redo). Next up: Phase 6 (organization & search). See `SPEC.md` §6.

## Development

```bash
npm install
npm run dev
npm test      # unit tests (Vitest)
```

The dev server sends `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` headers, required later for the WASM-threaded ASR engine (Phase 3) — make sure any production host does the same (see SPEC.md §5.6).

## ASR model assets

The `parakeet/` folder holds the on-device ONNX model files (INT8-quantized Parakeet TDT 0.6B v3, ~890MB). It's git-ignored — see `parakeet/README.md` for provenance and how to fetch it.
