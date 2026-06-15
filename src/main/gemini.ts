import { EventEmitter } from 'events'
import WebSocket = require('ws')

const GEMINI_WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.BidiGenerateContent'

export interface TranscriptData {
  original: string   // Renk A — kaynak dil
  translated: string // Renk B — hedef dil
  isFinal: boolean
}

export class GeminiLiveService extends EventEmitter {
  private ws: WebSocket | null = null
  private apiKey: string
  private sourceLang: string
  private targetLang: string
  private inputBuffer = ''
  private outputBuffer = ''

  constructor(apiKey: string, sourceLang: string, targetLang: string) {
    super()
    this.apiKey = apiKey
    this.sourceLang = sourceLang
    this.targetLang = targetLang
  }

  async start(): Promise<void> {
    const url = `${GEMINI_WS_URL}?key=${this.apiKey}`

    this.ws = new WebSocket(url)

    this.ws.on('open', () => {
      this.sendSetup()
    })

    this.ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString())
        this.handleMessage(msg)
      } catch (e) {
        console.error('Gemini WS parse error:', e)
      }
    })

    this.ws.on('error', (err) => {
      this.emit('error', err.message)
    })

    this.ws.on('close', (code) => {
      if (code !== 1000) {
        this.emit('error', `WebSocket closed with code ${code}`)
      }
    })
  }

  private sendSetup(): void {
    const sourceHint = this.sourceLang === 'auto' ? '' : `Input language: ${this.sourceLang}. `

    const setup = {
      setup: {
        model: 'models/gemini-2.0-flash-live-001',
        generation_config: {
          response_modalities: ['TEXT'],
          speech_config: {
            language_code: this.sourceLang === 'auto' ? undefined : this.sourceLang
          }
        },
        system_instruction: {
          parts: [{
            text: `${sourceHint}You are a real-time interpreter.
Transcribe the incoming audio and translate it to ${this.targetLang}.
For each utterance respond with a JSON object:
{"original": "<source language text>", "translated": "<${this.targetLang} translation>"}
Keep latency as low as possible. Output partial results as they come.`
          }]
        }
      }
    }

    this.ws?.send(JSON.stringify(setup))
    // After setup, start microphone streaming
    this.startMicrophoneStream()
  }

  private startMicrophoneStream(): void {
    // Microphone audio is sent from the renderer via IPC
    // See: renderer sends audio chunks → main forwards here
  }

  sendAudioChunk(pcm16Data: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    const chunk = {
      realtime_input: {
        media_chunks: [{
          mime_type: 'audio/pcm;rate=16000',
          data: pcm16Data.toString('base64')
        }]
      }
    }

    this.ws.send(JSON.stringify(chunk))
  }

  private handleMessage(msg: any): void {
    // Handle server content (transcripts)
    const parts = msg?.server_content?.model_turn?.parts
    if (!parts) return

    for (const part of parts) {
      if (part.text) {
        try {
          // Try JSON parse (full response)
          const parsed = JSON.parse(part.text)
          if (parsed.original !== undefined || parsed.translated !== undefined) {
            this.emit('transcript', {
              original: parsed.original || '',
              translated: parsed.translated || '',
              isFinal: !!msg?.server_content?.turn_complete
            } as TranscriptData)
            return
          }
        } catch {
          // Partial text chunk — accumulate
          this.outputBuffer += part.text
        }
      }
    }

    // Try parse accumulated buffer
    if (this.outputBuffer) {
      try {
        const parsed = JSON.parse(this.outputBuffer)
        if (parsed.original !== undefined || parsed.translated !== undefined) {
          this.emit('transcript', {
            original: parsed.original || '',
            translated: parsed.translated || '',
            isFinal: !!msg?.server_content?.turn_complete
          } as TranscriptData)
          this.outputBuffer = ''
        }
      } catch {
        // Not complete JSON yet, keep buffering
      }
    }

    if (msg?.server_content?.turn_complete) {
      this.outputBuffer = ''
      this.inputBuffer = ''
    }
  }

  async stop(): Promise<void> {
    if (this.ws) {
      this.ws.close(1000)
      this.ws = null
    }
  }
}
