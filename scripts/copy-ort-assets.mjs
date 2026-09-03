// Copies the onnxruntime-web WASM runtime files into public/ort/ so they're served
// locally (no CDN dependency, matches the app's no-external-network architecture).
// Re-run automatically via the "postinstall" npm script whenever dependencies change.
//
// engine.worker.ts imports 'onnxruntime-web/webgpu' (needed for the WebGPU EP), which
// resolves to ort.webgpu.bundle.min.mjs — that bundle loads the *asyncify* wasm variant,
// not the plain ort-wasm-simd-threaded one the wasm-only build used. Verified by
// grepping the bundle for which ort-wasm-simd-threaded.* filename it references.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = join(__dirname, '..', 'node_modules', 'onnxruntime-web', 'dist')
const destDir = join(__dirname, '..', 'public', 'ort')

const files = ['ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.asyncify.mjs']

mkdirSync(destDir, { recursive: true })
for (const file of files) {
  const src = join(srcDir, file)
  if (!existsSync(src)) {
    console.warn(`[copy-ort-assets] missing ${src}, skipping`)
    continue
  }
  copyFileSync(src, join(destDir, file))
}
console.log(`[copy-ort-assets] copied ${files.length} file(s) to public/ort/`)
