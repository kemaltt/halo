import { EventEmitter } from 'events'

// ── Shared types ────────────────────────────────────────────────

export interface TranscriptData {
  original: string   // Color A — kaynak dil (dim)
  translated: string // Color B — hedef dil (bright)
  isFinal: boolean
}

export type ProviderType = 'gemini' | 'openai'

export interface ProviderOptions {
  provider: ProviderType
  apiKey: string
  sourceLang: string // e.g. 'auto', 'tr-TR', 'de-DE'
  targetLang: string // e.g. 'en-US'
}

// ── Reconnect/backoff policy (shared by all providers) ──────────
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 15000
const RECONNECT_MAX_ATTEMPTS = 6

// ── Interface ───────────────────────────────────────────────────

/**
 * Every translation/STT provider must implement this interface.
 * Consumers (main process) only talk to this — never to a concrete class.
 *
 * Events emitted:
 *   'transcript'   → TranscriptData
 *   'error'        → string (human-readable message)
 *   'connected'    → void    (WS open / session ready)
 *   'disconnected' → void    (socket closed)
 *   'reconnecting' → number  (attempt #, while retrying with backoff)
 *   'stalled'      → void     (gave up after max attempts; stream is dead)
 */
export abstract class TranslationProvider extends EventEmitter {
  abstract start(opts: ProviderOptions): Promise<void>
  abstract stop(): Promise<void>
  abstract sendAudioChunk(pcm16: Buffer): void

  // Shared reconnect state.
  protected reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempts = 0

  // Convenience: emit typed events
  protected emitTranscript(data: TranscriptData): void {
    this.emit('transcript', data)
  }
  protected emitError(msg: string): void {
    this.emit('error', msg)
  }

  /** Call on a successful (re)connection to clear the backoff counter. */
  protected resetReconnect(): void {
    this.reconnectAttempts = 0
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
  }

  /**
   * Exponential backoff with jitter and a max-attempt ceiling. After the
   * ceiling it emits 'stalled' (and an error) instead of retrying forever.
   * `connect` should (re)establish the socket; `isStopped` short-circuits if
   * the caller has torn the provider down.
   */
  protected scheduleReconnect(connect: () => Promise<void>, isStopped: () => boolean): void {
    if (isStopped()) return
    this.reconnectAttempts++
    if (this.reconnectAttempts > RECONNECT_MAX_ATTEMPTS) {
      this.emitError('Bağlantı yeniden kurulamadı (stream stalled). Çeviri durduruldu.')
      this.emit('stalled')
      return
    }
    const exp = Math.min(RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1), RECONNECT_MAX_MS)
    const delay = Math.round(exp + Math.random() * 0.3 * exp) // up to +30% jitter
    this.emit('reconnecting', this.reconnectAttempts)
    this.reconnectTimer = setTimeout(() => {
      connect().catch(() => this.scheduleReconnect(connect, isStopped))
    }, delay)
  }
}
