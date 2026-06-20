import { contextBridge, ipcRenderer, clipboard } from 'electron'

contextBridge.exposeInMainWorld('subtl', {
  // Host OS — drives where system audio is captured (macOS = main/AudioTee,
  // Windows/other = renderer loopback).
  platform: process.platform,

  // Gemini control — the API key is NOT passed here; main reads it from secure
  // storage so the secret never lives in the renderer. For source 'system',
  // main captures audio itself (AudioTee); for 'mic' the renderer streams it.
  startTranslation: (opts: { provider: 'gemini' | 'openai'; sourceLang: string; targetLang: string; source: 'mic' | 'system' }) =>
    ipcRenderer.invoke('gemini:start', opts),
  stopTranslation: () => ipcRenderer.invoke('gemini:stop'),

  // API keys — encrypted at rest in main; renderer only sets / queries status.
  getKeyStatus: () => ipcRenderer.invoke('secrets:status'),
  setKey: (name: 'gemini' | 'openai' | 'anthropic', value: string) =>
    ipcRenderer.invoke('secrets:set', name, value),
  // Decrypt + return a stored key, only when the user clicks reveal/copy.
  getKey: (name: 'gemini' | 'openai' | 'anthropic'): Promise<string> =>
    ipcRenderer.invoke('secrets:get', name),

  // Audio chunk from renderer microphone → active provider (mic source).
  sendAudioChunk: (buffer: ArrayBuffer) =>
    ipcRenderer.send('audio:chunk', Buffer.from(buffer)),
  // Candidate mic chunk (interview + system mode) → transcription-only session.
  sendMicChunk: (buffer: ArrayBuffer) =>
    ipcRenderer.send('audio:chunk-mic', Buffer.from(buffer)),

  // Overlay control
  hideOverlay: () => ipcRenderer.invoke('overlay:hide'),
  showOverlay: () => ipcRenderer.invoke('overlay:show'),
  openSettings: () => ipcRenderer.invoke('settings:open'),
  closeSettings: () => ipcRenderer.invoke('settings:close'),

  // Reliable clipboard write (navigator.clipboard is flaky in Electron renderers).
  copyText: (text: string) => clipboard.writeText(text),

  // System-audio loopback (Phase 2) — bracket a getDisplayMedia call with these.
  enableLoopback: () => ipcRenderer.invoke('enable-loopback-audio'),
  disableLoopback: () => ipcRenderer.invoke('disable-loopback-audio'),

  // Interview mode (Phase 4) — Claude Haiku answer suggestions.
  // The Anthropic key is stored via setKey('anthropic', …), not here.
  setInterviewConfig: (cfg: { enabled: boolean; provider: 'claude' | 'gemini' | 'openai'; cvText: string; glossary: string; speakerLabels: boolean; ephemeral: boolean }) =>
    ipcRenderer.invoke('interview:config', cfg),
  // Privacy — wipe all stored session/history data.
  purgeData: () => ipcRenderer.invoke('data:purge'),
  onSuggestion: (cb: (data: { question: string; answer: string; type?: string }) => void) => {
    ipcRenderer.on('suggestion:update', (_e, data) => cb(data))
    return () => ipcRenderer.removeAllListeners('suggestion:update')
  },
  onSuggestionThinking: (cb: (question: string) => void) => {
    ipcRenderer.on('suggestion:thinking', (_e, q) => cb(q))
    return () => ipcRenderer.removeAllListeners('suggestion:thinking')
  },

  // Force an answer for the latest utterance (interview mode, manual trigger).
  answerNow: () => ipcRenderer.invoke('interview:answer-now'),

  // Provider connection status (connected / disconnected / reconnecting / stalled)
  onProviderStatus: (cb: (s: { state: 'connected' | 'disconnected' | 'reconnecting' | 'stalled'; attempt?: number }) => void) => {
    const onConn = () => cb({ state: 'connected' })
    const onDisc = () => cb({ state: 'disconnected' })
    const onRecon = (_e: unknown, attempt: number) => cb({ state: 'reconnecting', attempt })
    const onStall = () => cb({ state: 'stalled' })
    ipcRenderer.on('provider:connected', onConn)
    ipcRenderer.on('provider:disconnected', onDisc)
    ipcRenderer.on('provider:reconnecting', onRecon)
    ipcRenderer.on('provider:stalled', onStall)
    return () => {
      ipcRenderer.removeListener('provider:connected', onConn)
      ipcRenderer.removeListener('provider:disconnected', onDisc)
      ipcRenderer.removeListener('provider:reconnecting', onRecon)
      ipcRenderer.removeListener('provider:stalled', onStall)
    }
  },

  // Interview session window + log
  openSession: () => ipcRenderer.invoke('session:open'),
  getSession: () => ipcRenderer.invoke('session:list'),
  clearSession: () => ipcRenderer.invoke('session:clear'),
  summarizeSession: () => ipcRenderer.invoke('session:summarize'),
  analyzeSession: () => ipcRenderer.invoke('session:analyze'),
  exportSession: (format: 'md' | 'txt') => ipcRenderer.invoke('session:export', format),
  // Record the candidate's own answer for question #index.
  setMyAnswer: (index: number, text: string) =>
    ipcRenderer.invoke('session:set-answer', index, text),
  onSessionUpdate: (cb: (entries: any[]) => void) => {
    ipcRenderer.on('session:update', (_e, entries) => cb(entries))
    return () => ipcRenderer.removeAllListeners('session:update')
  },

  // Settings window open/closed state → toggles the overlay's gear/✕ button
  onSettingsState: (cb: (open: boolean) => void) => {
    ipcRenderer.on('settings:state', (_e, open) => cb(open))
    return () => ipcRenderer.removeAllListeners('settings:state')
  },

  // Listen for transcript updates from main
  onTranscript: (cb: (data: { original: string; translated: string; isFinal: boolean }) => void) => {
    ipcRenderer.on('transcript:update', (_e, data) => cb(data))
    return () => ipcRenderer.removeAllListeners('transcript:update')
  },

  // Listen for errors
  onError: (cb: (msg: string) => void) => {
    ipcRenderer.on('gemini:error', (_e, msg) => cb(msg))
    return () => ipcRenderer.removeAllListeners('gemini:error')
  }
})

// Type declaration (used in renderer)
export {}
