import WebSocket = require('ws')
import { TranslationProvider, TranscriptData, ProviderOptions } from './TranslationProvider'

// OpenAI Realtime API — gpt-4o-realtime-preview
// Does STT (via input_audio_transcription) + translation (via system prompt)
const WS_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview'

export class OpenAIRealtimeProvider extends TranslationProvider {
  private ws: WebSocket | null = null
  private opts: ProviderOptions | null = null
  private stopped = false

  // Buffer for response text (translated)
  private translatedBuffer = ''
  // Last confirmed original from transcription event
  private lastOriginal = ''

  async start(opts: ProviderOptions): Promise<void> {
    this.opts = opts
    this.stopped = false
    this.resetReconnect()
    await this.connect()
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.opts) return reject(new Error('No opts'))

      this.ws = new WebSocket(WS_URL, {
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      })

      this.ws.once('open', () => {
        this.resetReconnect()
        this.sendSetup()
        this.emit('connected')
        resolve()
      })

      this.ws.once('error', (err) => {
        this.emitError(`OpenAI connection error: ${err.message}`)
        reject(err)
      })

      this.ws.on('message', (data: Buffer) => {
        try {
          this.handleMessage(JSON.parse(data.toString()))
        } catch (e) {
          console.error('[OpenAI] parse error:', e)
        }
      })

      this.ws.on('close', (code) => {
        this.emit('disconnected')
        if (!this.stopped && code !== 1000) {
          this.emitError(`OpenAI WS closed (${code}) — reconnecting…`)
          this.scheduleReconnect(() => this.connect(), () => this.stopped)
        }
      })
    })
  }

  private sendSetup(): void {
    if (!this.opts) return
    const { sourceLang, targetLang } = this.opts
    const sourceHint = sourceLang === 'auto'
      ? 'Auto-detect the source language.'
      : `Source language is ${sourceLang}.`

    // Session config: text output only, PCM audio input, whisper transcription
    this.ws?.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text'],
        instructions:
          `${sourceHint} ` +
          `You are a real-time interpreter. ` +
          `For every utterance, output JSON only: ` +
          `{"original":"<source text>","translated":"<${targetLang} translation>"}. ` +
          `Keep latency minimal. Output partials as they arrive.`,
        input_audio_format: 'pcm16',
        input_audio_transcription: {
          model: 'whisper-1',
          language: sourceLang === 'auto' ? undefined : sourceLang.split('-')[0]
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500
        }
      }
    }))
  }

  sendAudioChunk(pcm16: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    this.ws.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: pcm16.toString('base64')
    }))
  }

  private handleMessage(msg: any): void {
    switch (msg.type) {
      // Original transcript from Whisper (input side)
      case 'conversation.item.input_audio_transcription.completed': {
        this.lastOriginal = msg.transcript || ''
        break
      }

      // Partial original transcript (interim)
      case 'conversation.item.input_audio_transcription.delta': {
        // Emit interim original alongside last known translation
        if (msg.delta) {
          this.emitTranscript({
            original: msg.delta,
            translated: this.translatedBuffer,
            isFinal: false
          })
        }
        break
      }

      // Translation text streaming (response side)
      case 'response.text.delta': {
        this.translatedBuffer += msg.delta || ''

        // Try to parse JSON from accumulated buffer
        try {
          const parsed = JSON.parse(this.translatedBuffer)
          if (parsed.original !== undefined || parsed.translated !== undefined) {
            this.emitTranscript({
              original: parsed.original || this.lastOriginal,
              translated: parsed.translated || '',
              isFinal: false
            })
          }
        } catch {
          // Not complete JSON yet — emit raw partial as translated
          if (this.translatedBuffer.length > 3) {
            this.emitTranscript({
              original: this.lastOriginal,
              translated: this.translatedBuffer,
              isFinal: false
            })
          }
        }
        break
      }

      // Response complete — final flush
      case 'response.text.done': {
        try {
          const parsed = JSON.parse(msg.text || this.translatedBuffer)
          this.emitTranscript({
            original: parsed.original || this.lastOriginal,
            translated: parsed.translated || this.translatedBuffer,
            isFinal: true
          })
        } catch {
          if (this.translatedBuffer) {
            this.emitTranscript({
              original: this.lastOriginal,
              translated: this.translatedBuffer,
              isFinal: true
            })
          }
        }
        this.translatedBuffer = ''
        this.lastOriginal = ''
        break
      }

      case 'error': {
        this.emitError(`OpenAI error: ${msg.error?.message || JSON.stringify(msg.error)}`)
        break
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close(1000)
      this.ws = null
    }
    this.translatedBuffer = ''
    this.lastOriginal = ''
  }
}
