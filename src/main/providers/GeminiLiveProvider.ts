import WebSocket = require('ws')
import { TranslationProvider, TranscriptData, ProviderOptions } from './TranslationProvider'

const WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'

// Dedicated live-translate model (verified available for this key via ListModels).
// Alternatives if this one is unavailable: 'models/gemini-3.1-flash-live-preview',
// 'models/gemini-2.5-flash-native-audio-latest'.
const MODEL = 'models/gemini-3.5-live-translate-preview'

export class GeminiLiveProvider extends TranslationProvider {
  private ws: WebSocket | null = null
  private originalBuf = ''
  private translatedBuf = ''
  private turnStartedAt = 0
  private opts: ProviderOptions | null = null
  private finalizeTimer: NodeJS.Timeout | null = null
  private stopped = false

  // This model doesn't reliably send turnComplete; close a turn after a pause.
  private static PAUSE_MS = 1200
  // …and force-close a turn that runs this long with no gap (continuous speech),
  // so history gets chunked instead of never recording a "final".
  private static MAX_TURN_MS = 8000

  async start(opts: ProviderOptions): Promise<void> {
    this.opts = opts
    this.stopped = false
    this.resetReconnect()
    await this.connect()
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.opts) return reject(new Error('No opts'))

      const url = `${WS_BASE}?key=${this.opts.apiKey}`
      this.ws = new WebSocket(url)

      this.ws.once('open', () => {
        this.resetReconnect() // clear backoff counter on a good connection
        this.sendSetup()
        this.emit('connected')
        resolve()
      })

      this.ws.once('error', (err) => {
        this.emitError(`Connection error: ${err.message}`)
        reject(err)
      })

      this.ws.on('message', (data: Buffer) => {
        try {
          this.handleMessage(JSON.parse(data.toString()))
        } catch (e) {
          console.error('[Gemini] parse error:', e)
        }
      })

      this.ws.on('close', (code, reason: Buffer) => {
        this.emit('disconnected')
        const why = reason?.toString() || '(no reason given)'
        // Full reason goes to the terminal; the overlay gets a short version.
        console.error(`[Gemini] WebSocket closed code=${code} reason=${why}`)
        if (!this.stopped && code !== 1000) {
          this.emitError(`WebSocket closed (${code}): ${why}`)
          // 1008 = bad setup/model, 1007 = bad payload — reconnecting won't help.
          if (code === 1008 || code === 1007) return
          this.scheduleReconnect(() => this.connect(), () => this.stopped)
        }
      })
    })
  }

  private sendSetup(): void {
    if (!this.opts) return

    const { targetLang } = this.opts

    // gemini-3.5-live-translate is a speech→speech translator: audio in →
    // translated AUDIO out, plus input/output transcriptions. We ignore the
    // audio and surface the two transcriptions as original / translated text.
    //
    // Translation target is set by generationConfig.translationConfig
    // (default "en" — hence English before this fix). targetLanguageCode wants
    // a SHORT BCP-47 code ("tr"), not the region form ("tr-TR").
    const target = (targetLang || 'en').split('-')[0]

    // inputAudioTranscription / outputAudioTranscription are setup-level fields
    // (BidiGenerateContentSetup), NOT generationConfig — putting them inside
    // generationConfig fails with 1007 "Unknown name ... Cannot find field".
    const setup = {
      setup: {
        model: MODEL,
        generationConfig: {
          responseModalities: ['AUDIO'],
          translationConfig: {
            targetLanguageCode: target,
            echoTargetLanguage: true
          }
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {}
      }
    }

    this.ws?.send(JSON.stringify(setup))
  }

  sendAudioChunk(pcm16: Buffer | Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    // Electron IPC delivers the renderer's Buffer as a Uint8Array, whose
    // toString('base64') ignores the encoding and emits "0,0,0,..." instead.
    // Wrap in a real Node Buffer so base64 encoding is correct.
    const data = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength).toString('base64')

    this.ws.send(JSON.stringify({
      realtimeInput: {
        mediaChunks: [{
          mimeType: 'audio/pcm;rate=16000',
          data
        }]
      }
    }))
  }

  private handleMessage(msg: any): void {
    const sc = msg?.serverContent
    if (!sc) return

    // The live-translate model streams two separate transcriptions:
    //   inputTranscription  → original speech
    //   outputTranscription → translated speech
    // (modelTurn.parts carries the translated AUDIO, which we ignore.)
    const inputText = sc.inputTranscription?.text
    const outputText = sc.outputTranscription?.text

    const wasEmpty = !this.originalBuf && !this.translatedBuf
    if (inputText) this.originalBuf += inputText
    if (outputText) this.translatedBuf += outputText
    if (wasEmpty && (this.originalBuf || this.translatedBuf)) this.turnStartedAt = Date.now()

    // Turn / generation boundary marks an utterance as complete.
    const isFinal = !!(sc.turnComplete || sc.generationComplete)

    if (inputText || outputText || isFinal) {
      if (this.originalBuf || this.translatedBuf) {
        this.emitTranscript({
          original: this.originalBuf.trim(),
          translated: this.translatedBuf.trim(),
          isFinal
        })
      }
    }

    if (isFinal) {
      this.clearFinalizeTimer()
      this.originalBuf = ''
      this.translatedBuf = ''
      this.turnStartedAt = 0
    } else if (inputText || outputText) {
      // Cap growth so a never-closing turn doesn't become an endless wall.
      const CAP = 400
      if (this.originalBuf.length > CAP) this.originalBuf = this.originalBuf.slice(-CAP)
      if (this.translatedBuf.length > CAP) this.translatedBuf = this.translatedBuf.slice(-CAP)
      // Continuous speech never leaves a gap, so also force-close an over-long
      // turn; otherwise (natural pause) the pause timer closes it.
      if (this.turnStartedAt && Date.now() - this.turnStartedAt >= GeminiLiveProvider.MAX_TURN_MS) {
        this.finalizeOnPause()
      } else {
        this.scheduleFinalize()
      }
    }
  }

  private scheduleFinalize(): void {
    this.clearFinalizeTimer()
    this.finalizeTimer = setTimeout(() => this.finalizeOnPause(), GeminiLiveProvider.PAUSE_MS)
  }

  private clearFinalizeTimer(): void {
    if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer)
      this.finalizeTimer = null
    }
  }

  private finalizeOnPause(): void {
    this.clearFinalizeTimer()
    if (!this.originalBuf && !this.translatedBuf) return
    this.emitTranscript({
      original: this.originalBuf.trim(),
      translated: this.translatedBuf.trim(),
      isFinal: true
    })
    this.originalBuf = ''
    this.translatedBuf = ''
    this.turnStartedAt = 0
  }

  async stop(): Promise<void> {
    this.stopped = true
    // Flush whatever's buffered as a final turn so the last utterance is recorded.
    this.finalizeOnPause()
    this.clearFinalizeTimer()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close(1000)
      this.ws = null
    }
  }
}
