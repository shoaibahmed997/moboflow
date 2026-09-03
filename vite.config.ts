import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const PARAKEET_DIR = join(import.meta.dirname, 'parakeet')
const MODEL_URL_PREFIX = '/models/parakeet/'
const ORT_DIST_DIR = join(import.meta.dirname, 'node_modules', 'onnxruntime-web', 'dist')
const ORT_URL_PREFIX = '/ort/'

/**
 * Dev-only static file server for the (git-ignored, ~890MB) Parakeet ONNX assets in
 * `parakeet/`, serving them at `/models/parakeet/*` with Range support so the app can
 * fetch them the same way it would from a real CDN in production. This is NOT a
 * production solution — deploying this app means pushing `parakeet/`'s contents to
 * actual static hosting/a CDN and pointing the model registry (Phase 8) at that URL
 * instead. See SPEC.md §5.2 and §6 Phase 3.
 */
function serveParakeetModels(): Plugin {
  return {
    name: 'serve-parakeet-models',
    configureServer(server) {
      server.middlewares.use(MODEL_URL_PREFIX, (req, res, next) => {
        const relPath = normalize(decodeURIComponent(req.url?.split('?')[0] ?? ''))
        if (relPath.startsWith('..') || relPath.split(sep).includes('..')) {
          res.statusCode = 400
          res.end('Invalid path')
          return
        }
        const filePath = join(PARAKEET_DIR, relPath)
        if (!existsSync(filePath) || !statSync(filePath).isFile()) {
          next()
          return
        }

        const stat = statSync(filePath)
        res.setHeader('Accept-Ranges', 'bytes')
        res.setHeader('Content-Type', 'application/octet-stream')
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')

        const range = req.headers.range
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range)
          const start = match?.[1] ? Number(match[1]) : 0
          const end = match?.[2] ? Number(match[2]) : stat.size - 1
          res.statusCode = 206
          res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`)
          res.setHeader('Content-Length', end - start + 1)
          createReadStream(filePath, { start, end }).pipe(res)
        } else {
          res.setHeader('Content-Length', stat.size)
          createReadStream(filePath).pipe(res)
        }
      })
    },
  }
}

/**
 * Dev-only static file server for the onnxruntime-web WASM runtime, serving straight
 * from node_modules instead of public/ort/ (which the postinstall script populates
 * for the *production* build). Necessary because onnxruntime-web loads its WASM glue
 * via a runtime `import()`, and Vite's dev server categorically refuses to serve
 * public/ files through its module-transform middleware when they're requested that
 * way ("should not be imported from source code... can only be referenced via HTML
 * tags") — this middleware runs before that restriction kicks in.
 */
function serveOrtAssets(): Plugin {
  return {
    name: 'serve-ort-assets',
    configureServer(server) {
      server.middlewares.use(ORT_URL_PREFIX, (req, res, next) => {
        const relPath = normalize(decodeURIComponent(req.url?.split('?')[0] ?? ''))
        if (relPath.startsWith('..') || relPath.split(sep).includes('..')) {
          res.statusCode = 400
          res.end('Invalid path')
          return
        }
        const filePath = join(ORT_DIST_DIR, relPath)
        if (!existsSync(filePath) || !statSync(filePath).isFile()) {
          next()
          return
        }
        res.setHeader('Content-Type', filePath.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
        createReadStream(filePath).pipe(res)
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    serveParakeetModels(),
    serveOrtAssets(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Moboflow',
        short_name: 'Moboflow',
        description: "Let your thoughts flow into your mobile — on-device voice transcription.",
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          {
            src: 'icons/icon-192.svg',
            sizes: '192x192',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: 'icons/icon-512.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: 'icons/icon-maskable.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // App-shell assets only — model weights and the ORT WASM runtime are fetched
        // and cached on demand via the Cache API (src/lib/asr/modelCache.ts), not
        // precached by Workbox: they're hundreds of MB and shouldn't block install.
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        navigateFallbackDenylist: [/^\/models\//, /^\/ort\//],
      },
      devOptions: {
        enabled: true,
      },
    }),
  ],
  server: {
    // Required for WASM threads (SharedArrayBuffer) in the ASR worker.
    // The production host must send these same headers — see SPEC.md §5.6.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // onnxruntime-web/webgpu is only imported from src/lib/asr/engine.worker.ts, so Vite's
    // static dependency scanner (which doesn't crawl worker entry files) misses it and
    // only discovers it at runtime when the worker first executes — triggering a forced
    // "new dependency optimized, reloading page" mid-session reload that wipes out any
    // in-progress model download. Pre-registering it here avoids that reload.
    include: ['onnxruntime-web/webgpu'],
  },
})
