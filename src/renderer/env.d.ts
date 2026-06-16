/// <reference types="vite/client" />

export interface SessionEntry {
  original: string
  translated: string
  answer?: string    // the AI-suggested answer (if any)
  myAnswer?: string  // the candidate's own/actual answer for this question
  qtype?: string     // question category (behavioral, technical, …)
  speaker?: 'them' | 'me'  // who spoke this turn (speaker-labels mode)
}

export type SecretName = 'gemini' | 'openai' | 'anthropic'

export interface KeyStatus {
  available: boolean
  gemini: boolean
  openai: boolean
  anthropic: boolean
}

export interface SubtlBridge {
  platform: string  // process.platform of the host (e.g. 'darwin', 'win32')

  startTranslation: (opts: {
    provider: 'gemini' | 'openai'
    sourceLang: string
    targetLang: string
    source: 'mic' | 'system'
  }) => Promise<{ ok: boolean; error?: string }>

  stopTranslation: () => Promise<{ ok: boolean }>

  getKeyStatus: () => Promise<KeyStatus>
  setKey: (name: SecretName, value: string) => Promise<{ ok: boolean; error?: string; gemini?: boolean; openai?: boolean; anthropic?: boolean }>
  getKey: (name: SecretName) => Promise<string>

  sendAudioChunk: (buffer: ArrayBuffer) => void
  sendMicChunk: (buffer: ArrayBuffer) => void

  hideOverlay: () => Promise<void>
  showOverlay: () => Promise<void>
  openSettings: () => Promise<void>
  closeSettings: () => Promise<void>
  copyText: (text: string) => void
  enableLoopback: () => Promise<void>
  disableLoopback: () => Promise<void>
  setInterviewConfig: (cfg: { enabled: boolean; cvText: string; glossary: string; speakerLabels: boolean }) => Promise<void>
  onSuggestion: (cb: (data: { question: string; answer: string; type?: string }) => void) => (() => void) | undefined
  onSuggestionThinking: (cb: (question: string) => void) => (() => void) | undefined
  answerNow: () => Promise<void>

  onProviderStatus: (
    cb: (s: { state: 'connected' | 'disconnected' | 'reconnecting' | 'stalled'; attempt?: number }) => void
  ) => (() => void) | undefined

  openSession: () => Promise<void>
  getSession: () => Promise<SessionEntry[]>
  clearSession: () => Promise<void>
  summarizeSession: () => Promise<string>
  analyzeSession: () => Promise<string>
  exportSession: (format: 'md' | 'txt') => Promise<{ ok: boolean; path?: string; error?: string }>
  setMyAnswer: (index: number, text: string) => Promise<void>
  onSessionUpdate: (cb: (entries: SessionEntry[]) => void) => (() => void) | undefined
  onSettingsState: (cb: (open: boolean) => void) => (() => void) | undefined

  onTranscript: (
    cb: (data: { original: string; translated: string; isFinal: boolean }) => void
  ) => (() => void) | undefined

  onError: (cb: (msg: string) => void) => (() => void) | undefined
}

declare global {
  interface Window {
    subtl: SubtlBridge
  }
}
