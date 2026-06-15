import { app } from 'electron'
import { dirname, join } from 'path'
// Type-only — erased at compile time, so it does NOT emit a require() of the
// ESM-only `audiotee` package (which would throw ERR_REQUIRE_ESM in the CJS
// main bundle). The actual module is pulled in via dynamic import() at runtime.
import type { AudioTee } from 'audiotee'

// System-audio capture for the OTHER participant, in the MAIN process.
//
// AudioTee taps Core Audio (macOS 14.2+) and streams PCM straight to us — no
// renderer round-trip, no getDisplayMedia, no screen-recording permission (only
// the "System Audio Recording" TCC permission, NSAudioCaptureUsageDescription).
// Asking for a 16 kHz sample rate makes AudioTee emit 16-bit signed PCM, exactly
// what the translation providers expect — so we forward chunks verbatim.

// Lower than the 200 ms default to keep the caption path snappy.
const CHUNK_MS = 100

/** Locate the bundled AudioTee binary, accounting for the packaged asar layout. */
function resolveBinaryPath(): string | undefined {
  try {
    // require.resolve('audiotee') → …/node_modules/audiotee/dist/index.js
    const base = join(dirname(require.resolve('audiotee')), '..', 'bin', 'audiotee')
    // In a packaged app the binary lives in app.asar.unpacked (see asarUnpack);
    // AudioTee's own import.meta.url resolution would otherwise point into the asar.
    return app.isPackaged ? base.replace('app.asar', 'app.asar.unpacked') : base
  } catch {
    return undefined // dev: let AudioTee resolve the bin relative to itself
  }
}

export class SystemAudioCapture {
  private tee: AudioTee | null = null

  isActive(): boolean {
    return this.tee !== null
  }

  async start(onPcm: (pcm16: Buffer) => void, onError: (msg: string) => void): Promise<void> {
    // Dynamic import keeps this as a real import() in the CJS bundle so the
    // ESM-only package loads correctly under Electron's Node.
    const { AudioTee } = await import('audiotee')

    const binaryPath = resolveBinaryPath()
    this.tee = new AudioTee({ sampleRate: 16000, chunkDurationMs: CHUNK_MS, ...(binaryPath ? { binaryPath } : {}) })

    this.tee.on('data', (chunk) => onPcm(chunk.data))
    this.tee.on('error', (err) => onError(err?.message || 'System audio capture error'))

    await this.tee.start()
  }

  async stop(): Promise<void> {
    if (!this.tee) return
    try { await this.tee.stop() } catch { /* already stopped */ }
    this.tee = null
  }
}
