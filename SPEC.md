# Moboflow — Spec Sheet

> Let your thoughts flow into your mobile.

Extends [plan.md](./plan.md). Moboflow is an installable PWA that turns continuous speech into streaming text using an on-device Parakeet ASR model, with no audio ever leaving the device.

---

## 1. Product Summary

|                    |                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| **Core loop**      | Tap record → speak continuously → see text stream in real time → stop → transcript is saved locally      |
| **Platform**       | Installable PWA (mobile-first, works on desktop)                                                         |
| **ASR**            | NVIDIA Parakeet, converted to ONNX and run on-device via WASM/WebGPU                                     |
| **Storage**        | 100% local — IndexedDB (transcripts, sessions), Cache API (model weights)                                |
| **Privacy stance** | No backend, no audio upload, no account. This is the product's core differentiator, not an afterthought. |

### Non-goals (v1)

- No cloud sync / multi-device
- No speaker diarization
- No real-time translation
- No account system or auth

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser (PWA)                         │
│                                                                │
│  ┌───────────┐   PCM chunks   ┌──────────────────────────┐  │
│  │  Mic input │ ─────────────▶ │   AudioWorklet + VAD      │  │
│  │ getUserMedia│                │  (resample → 16kHz,      │  │
│  └───────────┘                │   segment speech/silence) │  │
│                                 └────────────┬─────────────┘  │
│                                              │ audio frames    │
│                                              ▼                 │
│                          ┌──────────────────────────────┐     │
│                          │   Web Worker: ASR Engine       │     │
│                          │   onnxruntime-web (WASM/WebGPU)│     │
│                          │   Parakeet encoder + decoder    │     │
│                          └────────────┬─────────────────┘     │
│                                       │ partial/final text      │
│                                       ▼                         │
│                          ┌──────────────────────────────┐     │
│                          │      React UI (main thread)   │     │
│                          │  live transcript, sessions,    │     │
│                          │  folders, search, editor       │     │
│                          └────────────┬─────────────────┘     │
│                                       │                         │
│                                       ▼                         │
│                          ┌──────────────────────────────┐     │
│                          │  IndexedDB (Dexie)             │     │
│                          │  sessions / segments / tags     │     │
│                          │  Cache API: model weights (.onnx)│    │
│                          └──────────────────────────────┘     │
│                                                                │
│  Service Worker: app-shell caching, model asset caching,      │
│  offline-first navigation                                     │
└─────────────────────────────────────────────────────────────┘
```

All inference and storage happen client-side. There is no application backend in v1 — only static hosting for the PWA bundle and model files (e.g., a CDN).

---

## 3. Tech Stack

| Layer          | Choice                                                  | Notes                                                                                   |
| -------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Framework      | React 18 + Vite + TypeScript                            | Fast dev loop, mature PWA plugin support                                                |
| PWA tooling    | `vite-plugin-pwa` (Workbox under the hood)              | Service worker, manifest, precaching                                                    |
| Local DB       | Dexie.js over IndexedDB                                 | Ergonomic queries, schema versioning/migrations                                         |
| ASR runtime    | `onnxruntime-web`                                       | WASM (SIMD+threads) backend for broad support, WebGPU backend where available for speed |
| Audio pipeline | Web Audio API `AudioWorkletNode`                        | Runs off the main thread, avoids `ScriptProcessorNode`                                  |
| VAD            | Silero VAD (ONNX, tiny) or energy-based fallback        | Segments continuous speech into decodable windows                                       |
| Search         | FlexSearch (in-memory index built from IndexedDB)       | Full-text search over saved transcripts                                                 |
| State mgmt     | Zustand or React Context (keep light)                   | No Redux needed for this scope                                                          |
| Styling        | Tailwind CSS                                            | Fast to build a clean mobile-first UI                                                   |
| Testing        | Vitest (unit), Playwright (e2e, incl. mocked mic input) |                                                                                         |

---

## 4. Data Model (IndexedDB via Dexie)

```ts
interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  durationMs: number;
  language: string; // BCP-47 tag, e.g. "en-US"
  folderId?: string;
  tags: string[];
  status: "recording" | "complete" | "draft";
}

interface Segment {
  id: string;
  sessionId: string;
  startMs: number;
  endMs: number;
  text: string;
  isEdited: boolean; // user manually edited this segment
  confidence?: number;
}

interface Folder {
  id: string;
  name: string;
  parentId?: string;
  createdAt: number;
}

interface ModelAsset {
  id: string; // e.g. "parakeet-tdt-0.6b-en-int8"
  version: string;
  sizeBytes: number;
  cachedAt: number;
}
```

---

## 5. Key Technical Risks (read before Phase 1)

These determine whether the on-device approach is viable as scoped. Phase 0 exists specifically to de-risk them.

1. **Parakeet is not natively browser-shaped.** NVIDIA's Parakeet models (NeMo, TDT/RNNT/CTC variants, 0.6B–1.1B params) have no official ONNX/WASM export. Conversion (NeMo → ONNX → INT8 quantization) is required. **Resolved for v1:** a pre-converted INT8 ONNX build is already checked in locally at `parakeet/` (encoder + decoder_joint + vocab, weight-only INT8 quantization, community conversion of `nvidia/parakeet-tdt-0.6b-v3`, CC-BY-4.0). See `parakeet/README.md`.
2. **Model size vs. mobile download/storage.** Confirmed, and worse than the original 150–300MB estimate: the checked-in build is **~890MB total** (`encoder-int8.onnx.data` alone is 838MB). First-run download experience and Cache API storage quota (especially iOS Safari's eviction behavior) are a hard requirement, not a nice-to-have, and 890MB over cellular is a real adoption barrier — a background/resumable download with clear progress UI is not optional. Revisit whether a smaller checkpoint is worth sourcing before Phase 3.
3. **True streaming needs a cache-aware/streaming-capable variant.** Standard offline Parakeet checkpoints decode a full utterance at once. **Unresolved:** the checked-in build is the standard `parakeet-tdt-0.6b-v3` checkpoint, not a confirmed cache-aware streaming variant — Phase 0 must still verify how it behaves on rolling/chunked audio windows (re-decoding a growing window is a workable but higher-compute stand-in for true streaming) before committing to the "continuous streaming" UX promise in plan.md.
4. **Mobile CPU inference speed.** WASM (even SIMD+threaded) on a mid-range phone may not hit real-time factor for a 0.6B model. WebGPU backend helps but has inconsistent mobile support (notably iOS Safari). A smaller distilled/quantized variant may be required as the real v1 target.
5. **iOS Safari PWA constraints.** No Web Share Target API, background mic capture is restricted when the tab isn't foregrounded, storage can be evicted under pressure, no WebGPU (as of this writing) — plan the "installed PWA" experience assuming Safari is the worst-supported target, not an edge case.
6. **Threading requires cross-origin isolation.** WASM threads need `COOP`/`COEP` response headers from the host — a hosting/deployment constraint, not just a code one.

---

## 6. Phased Implementation Plan

### Phase 0 — Feasibility Spike (no product code)

**Goal:** prove the on-device ASR path works before building anything on top of it.

- ~~Select a specific Parakeet checkpoint~~ — done: `nvidia/parakeet-tdt-0.6b-v3`, INT8 ONNX, checked in at `parakeet/` (not yet verified as streaming/cache-aware — see risk #3)
- ~~Convert to ONNX; quantize (INT8)~~ — done (community conversion, weight-only INT8 on MatMul/Gemm); accuracy delta from quantization still needs measuring
- Load in `onnxruntime-web`, benchmark inference latency/RTF on: a mid-range Android phone, an iPhone (Safari), and desktop Chrome — **still open**
- Prototype the audio capture → 16kHz PCM → chunk pipeline standalone (no UI) — **still open**
- Decide: WASM-only vs. WASM+WebGPU-when-available — **still open**
- Confirm whether rolling-window re-decode on this non-streaming checkpoint hits acceptable latency, or whether a genuinely streaming checkpoint is needed — **still open, see risk #3**
- **Exit criteria:** a checked-in benchmark report + a go/no-go on Parakeet vs. fallback model, with numbers (model size, load time, real-time factor per device class)

### Phase 1 — PWA Skeleton ✅ (this session)

**Goal:** installable, offline-capable app shell with no ASR yet.

- [x] React + Vite + TS project scaffold
- [x] `vite-plugin-pwa` config: manifest (icons, splash, theme), Workbox precaching for the app shell
- [x] Base routing: Home (record), Sessions list, Session detail
- [x] Dexie schema set up per §4, with migration scaffolding (`db.version(1).stores(...)`)
- [x] Install prompt UX (A2HS)
- **Exit criteria:** Lighthouse PWA score passing, app installs and opens offline (shell only) — build/lint verified clean; Lighthouse run still pending on a deployed instance

### Phase 2 — Audio Capture & VAD ✅ (this session)

**Goal:** reliable mic capture pipeline feeding fixed-format audio frames.

- [x] `getUserMedia` with proper permission-denied/unavailable states
- [x] `AudioWorkletNode` for capture off the main thread; resample to model's expected rate (linear interpolation to 16kHz, `public/worklets/capture-processor.js`)
- [x] VAD integration to segment continuous speech into decodable chunks and detect end-of-utterance (energy-based with hysteresis + hangover, `src/lib/audio/vad.ts` — the spec's documented fallback option, not Silero)
- [x] Visual mic-level indicator (basic waveform/level meter) for user feedback
- **Exit criteria:** can record continuously for 5+ minutes and emit correctly segmented audio chunks — verified structurally + end-to-end via a fake-microphone browser test (see Phase 3); a real 5+ minute on-device recording session is still worth doing manually before calling this closed

### Phase 3 — On-Device ASR Integration ✅ (this session)

**Goal:** live streaming transcription in the UI.

- [x] Load the chosen ONNX model + tokenizer in a Web Worker via `onnxruntime-web` (`src/lib/asr/engine.worker.ts`)
- [x] Model download-and-cache flow (Cache API), with progress UI and re-use across sessions (`src/lib/asr/modelCache.ts`)
- [x] Decode loop: audio chunks in → interim hypotheses out → finalized text on VAD endpoint. Implemented as **chunked re-decode** (full encoder + greedy-TDT pass per buffer), not true incremental streaming — this is the non-streaming `parakeet-tdt-0.6b-v3` checkpoint (risk #3 confirmed: not cache-aware), so "streaming" here means periodic re-decode of the growing/finalized VAD segment, not frame-by-frame emission
- [x] Wire worker output into the UI as live streaming text (interim text visually distinct from finalized text)
- [x] Error/fallback states: model load failure, mic error, per-transcription error — surfaced in the UI
- **Exit criteria:** ✅ verified end-to-end with a real (non-mocked) test: Chromium fed synthesized speech via `--use-file-for-fake-audio-capture`, full pipeline exercised for real (mic → resample → VAD → mel features → encoder → greedy TDT decode → tokenizer), produced correct transcript text back in the UI. Formal cross-device latency benchmarking (Phase 0's original ask) is still outstanding.

**Critical bug found and fixed this session:** onnxruntime-web's multi-threaded WASM backend spawns its own pthread pool via nested Web Workers; running that _inside_ our own dedicated ASR Worker deadlocks session creation indefinitely (confirmed via timed A/B — multi-threaded never completed in 10+ minutes, single-threaded completed in ~1.7s — and independently reproduced in a real browser during manual testing, not just headless Chromium). Fixed by forcing `ort.env.wasm.numThreads = 1`. This trades inference speed for correctness/reliability; revisiting multi-threading (by moving the engine off a dedicated Worker, or evaluating the WebGPU EP instead, which needs no pthread pool) is a Phase 9 performance follow-up, not a blocker.

**Also found and fixed:** two Vite dev-server-only quirks (dynamic `import()` of `public/` files is refused by Vite's dev transform middleware; `onnxruntime-web/wasm` wasn't discovered by Vite's dependency scanner since it's only imported from a Worker entry, causing a disruptive mid-session reload) — see `vite.config.ts` comments. Neither affects the production build.

### Phase 4 — Session Persistence ✅ (this session)

**Goal:** transcripts survive reloads and are structured, not just a text blob.

- [x] Session lifecycle: start/pause/resume/stop, autosave in-progress sessions. The recorder now lives in an app-level provider (`src/lib/recorder/RecorderProvider.tsx`), so a live session — and the loaded ASR engine — survive route changes (previously navigating away from Home tore down the mic _and_ the worker). Pause releases the mic; the session timeline continues across pause/resume and across resuming a recovered draft. A 5s heartbeat (plus a save on `visibilitychange`/`pagehide`) keeps `durationMs`/`updatedAt` current.
- [x] Persist segments (with timestamps) to Dexie as they finalize (`src/lib/sessions.ts`). The VAD now reports sample-accurate `startSample`/`endSample` per utterance (end excludes the hangover silence, so inter-segment gaps are real pause lengths — useful for Phase 5 paragraphing), and caps pause-free utterances at ~30s (cut at the next energy dip, hard cut at 45s) so a long monologue is still persisted regularly.
- [x] Sessions list view (most recent first, status + duration), session detail with per-segment timestamps
- [x] Delete/rename session. Delete is transactional with its segments; segments that finish transcribing after their session was deleted are dropped rather than orphaned.
- **Exit criteria:** ✅ verified end-to-end with a real browser + real model: recorded via Chromium's fake mic, SIGKILLed the browser mid-recording, relaunched on the same profile → session recovered as `draft` with all finalized segments, resumed, stopped → `complete` with monotonic timestamps across the crash. The utterance _in progress_ at kill time is lost by design (only finalized utterances are persisted); the 30s segment cap bounds that loss.

Status semantics: `recording` = owned by a live tab (recording or paused); `draft` = interrupted (tab died) and resumable; `complete` = stopped and fully transcribed. Liveness uses the Web Locks API (a tab holds `moboflow:session:<id>` while it owns a session; the browser releases it the instant the tab dies), with heartbeat staleness (>20s) as the fallback where Web Locks is unavailable. Stopping a session with nothing transcribed deletes it instead of saving an empty entry.

**Also fixed:** utterances finalized while the model was still downloading/initializing were silently dropped (the old Home only called `transcribe` once the engine was `ready`) — the worker now queues jobs until init completes. A failed engine load now tears the worker down so it can be retried from the UI. `useMicCapture` no longer overwrites its `error` status with `idle` on a failed start. Added Vitest (pinned to v4: v5 requires Node 22+) with unit tests for VAD timing and the session repository (`fake-indexeddb`).

### Phase 5 — Editing & Cleanup ✅ (this session)

**Goal:** raw ASR output becomes something a user would actually keep.

- [x] Inline text editing per segment, with `isEdited` tracking. Tap any sentence in Session detail to edit it in place (Enter or blur saves, Esc cancels); the editor also offers *Delete sentence* and, for edited segments, *Revert to original*. The first edit stores the model's raw text in a new non-indexed `Segment.originalText` field (no Dexie version bump needed); editing back to exactly the raw text clears `isEdited`.
- [x] Auto-formatting pass (`src/lib/transcript/format.ts`). **Non-destructive / display-time**: stored text stays the raw model output, so rules can improve (or a cleanup model can replace them — see plan.md) without data migration, and pre-Phase-5 sessions benefit automatically. Parakeet v3 already emits punctuation and casing, so the pass is deliberately light: whitespace + space-before-punctuation fixes, standalone `i` → `I`, sentence-start capitalization (abbreviation-aware: `i.e.`, `Dr.`, `vs.`…), terminal period when missing, and hesitation-filler removal (`um`/`uh`/`erm`, keeping `uh-huh`, `umbrella`). Edited segments are shown verbatim.
- [x] Paragraph breaks on long pauses using the VAD gap timing from Phase 4: a gap ≥ 2s starts a new paragraph (timestamped in the gutter). Segments < 300ms apart are recognized as one utterance split by the VAD's 30s max-length cut, so no false sentence boundary (period/capital) is inserted between them.
- [x] Undo/redo for manual edits (`src/lib/transcript/useSegmentEditor.ts`): edits, deletes and reverts are all recorded as full before/after segment snapshots and applied through one write primitive (`writeSegmentState`), serialized through a promise chain so rapid taps can't desync storage and the stack. Undo/Redo buttons plus ⌘Z / ⇧⌘Z / Ctrl+Y (ignored while typing, where native textarea undo applies). History is per page visit.
- The live transcript on the Record screen uses the same formatted paragraph view (read-only).
- **Exit criteria:** ✅ verified end-to-end in Chromium at phone viewport against a seeded messy transcript (fillers, lowercase `i`, stray spaces before commas, a filler-only segment, a long pause): it renders as clean two-paragraph prose before any manual editing, and the edit → undo → redo → delete → undo → cancel → revert flow round-trips correctly through IndexedDB with no page errors.

### Phase 6 — Organization & Search

**Goal:** transcripts are findable once there are dozens/hundreds of them.

- Folders (flat or one-level nesting) and free-form tags
- Search UI: query box, results with snippet highlighting
- Sort/filter by date, folder, tag
- **Exit criteria:** can find a specific transcript by content, tag, or folder.

### Phase 7 — Export & Share

**Goal:** get text out of the app.

- Copy-to-clipboard (single segment or full transcript)
- Export as `.txt` / `.md` (file download)
- Web Share API integration where supported
- **Exit criteria:** exported `.md` opens cleanly in a standard notes app

### Phase 8 — Multi-Language Support

**Goal:** language selection drives which model is loaded.

- Language picker UI, persisted as a user preference and per-session
- Model registry: map language → ONNX asset (may mean shipping/caching multiple models, or one multilingual checkpoint if Phase 0 identifies a viable one)
- Handle multi-model storage budget (only cache languages the user has actually used; evict least-recently-used on quota pressure)
- **Exit criteria:** switch language, record, get correctly-language transcription, without re-downloading on every switch

### Phase 9 — Performance, Offline & Accessibility Hardening

**Goal:** production-grade robustness, not just happy-path demo.

- Full offline test matrix: cold start offline, model already cached vs. not
- Storage quota handling: graceful messaging when IndexedDB/Cache API quota is exceeded or evicted
- Cross-device test pass: low-end Android, recent iPhone Safari, desktop Chrome/Edge/Firefox
- **Exit criteria:** no crashes/data loss across the test matrix; documented known limitations per browser

### Phase 10 — Launch Prep

**Goal:** ready to actually ship and hand to real users.

- Final Lighthouse/PWA audit, app icons/splash screens polished
- Onboarding flow explaining the privacy model (no cloud, first-run model download) and mic permission ask
- Basic opt-in, local-only usage stats if desired (no third-party analytics given the privacy stance)
- Deployment: static hosting with correct `COOP`/`COEP` headers (per §5.6) and long-cache headers for model assets
- README / user-facing docs
- **Exit criteria:** a stranger can install the PWA, grant mic permission, and get a working streaming transcription with zero prior context
