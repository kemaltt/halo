import { app, BrowserWindow, ipcMain, globalShortcut, screen, session, systemPreferences, dialog } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import { initMain as initLoopbackAudio } from 'electron-audio-loopback'
import type { TranslationProvider, ProviderType } from './providers/TranslationProvider'
import { GeminiLiveProvider } from './providers/GeminiLiveProvider'
import { OpenAIRealtimeProvider } from './providers/OpenAIRealtimeProvider'
import { InterviewAssistant, type Suggestion } from './suggestions/InterviewAssistant'
import { getSecret, setSecret, secretStatus, isSecureStorageAvailable, type SecretName } from './secrets'
import { SystemAudioCapture } from './audio/SystemAudioCapture'

let overlayWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
let sessionWindow: BrowserWindow | null = null

// Active translation provider — swappable via interface
let provider: TranslationProvider | null = null

// System-audio capture (other participant) — runs in main via AudioTee.
const systemAudio = new SystemAudioCapture()

// Candidate's own mic, transcription-only (interview mode): a SECOND provider
// session fed by the renderer mic, so we capture what the candidate actually
// answered. We read only its `original` text (no translation needed).
let candidateStt: TranslationProvider | null = null

// Conversation history — the source of truth, accumulates across stop/start.
// Works in both modes: plain transcript turns, plus answers in interview mode.
interface HistoryEntry { original: string; translated: string; answer?: string; myAnswer?: string; qtype?: string; speaker?: 'them' | 'me' }
let sessionLog: HistoryEntry[] = []

// Persist the session log to disk (userData) so it survives restarts. Stays
// local — consistent with the "your data never leaves the device" stance.
const sessionFile = (): string => join(app.getPath('userData'), 'halo-session.json')
function loadSession(): void {
  try {
    const f = sessionFile()
    if (existsSync(f)) sessionLog = JSON.parse(readFileSync(f, 'utf8')) as HistoryEntry[]
  } catch (e) { console.error('[session] load failed:', e) }
}
let ephemeral = false // when true, never write the transcript to disk
function persistSession(): void {
  if (ephemeral) return
  try { writeFileSync(sessionFile(), JSON.stringify(sessionLog), { mode: 0o600 }) }
  catch (e) { console.error('[session] write failed:', e) }
}
function deleteSessionFile(): void {
  try { if (existsSync(sessionFile())) unlinkSync(sessionFile()) }
  catch (e) { console.error('[session] delete failed:', e) }
}

function broadcast(channel: string, payload?: unknown): void {
  overlayWindow?.webContents.send(channel, payload)
  sessionWindow?.webContents.send(channel, payload)
}

// Persist + push the full history to any open session window.
function emitSession(): void {
  persistSession()
  broadcast('session:update', sessionLog)
}

// Append a finalized transcript turn (deduped against the previous one).
function recordTurn(original: string, translated: string): void {
  const o = (original || '').trim()
  const t = (translated || '').trim()
  if (!o && !t) return
  const last = sessionLog[sessionLog.length - 1]
  if (last && last.original === o && last.translated === t) return
  sessionLog.push({ original: o, translated: t, speaker: 'them' })
  emitSession()
}

// A finalized candidate (mic) utterance as its OWN labeled entry — used in the
// speaker-labels transcript mode (non-interview).
function recordCandidateTurn(text: string): void {
  const t = (text || '').trim()
  if (!t) return
  sessionLog.push({ original: t, translated: '', speaker: 'me' })
  emitSession()
}

// Attach a finalized candidate (mic) utterance to the latest question as the
// answer they actually gave. Multiple utterances accumulate.
function recordCandidateAnswer(text: string): void {
  const t = (text || '').trim()
  if (!t) return
  const last = sessionLog[sessionLog.length - 1]
  if (last) last.myAnswer = `${last.myAnswer ? last.myAnswer + ' ' : ''}${t}`.trim()
  else sessionLog.push({ original: '', translated: '', myAnswer: t })
  emitSession()
}

async function stopCandidateStt(): Promise<void> {
  await candidateStt?.stop()
  candidateStt = null
}

// Interview suggestion sidecar (Claude Haiku, async — never blocks captions)
const interviewAssistant = new InterviewAssistant()
interviewAssistant.on('thinking', (question: string) =>
  broadcast('suggestion:thinking', question))
interviewAssistant.on('suggestion', (data: Suggestion) => {
  // Attach the answer to the matching turn (or the latest answer-less one).
  const q = data.question
  let target = [...sessionLog].reverse().find(
    e => !e.answer && ((e.original || '').trim() === q || (e.translated || '').trim() === q))
  if (!target) target = [...sessionLog].reverse().find(e => !e.answer)
  if (target) { target.answer = data.answer; target.qtype = data.type }
  else sessionLog.push({ original: data.original, translated: data.translated, answer: data.answer, qtype: data.type })

  broadcast('suggestion:update', data)    // latest answer → overlay panel
  emitSession() // full history → history window
})
interviewAssistant.on('error', (msg: string) =>
  broadcast('suggestion:error', msg))

// Interview prefs live in main; the Anthropic key comes from secure storage,
// never from the renderer. Re-apply whenever either changes.
let interviewEnabled = false
let interviewCv = ''
let interviewGlossary = ''
let speakerLabels = false // capture mic in non-interview system mode for "you vs them"
function applyInterviewConfig(): void {
  interviewAssistant.setConfig({
    enabled: interviewEnabled,
    apiKey: getSecret('anthropic'),
    cvText: interviewCv,
    glossary: interviewGlossary
  })
}

// System-audio loopback (Phase 2): registers the command-line feature switch
// (must run before app 'ready') and the enable/disable-loopback IPC handlers.
initLoopbackAudio()

function createOverlayWindow(): void {
  const { width } = screen.getPrimaryDisplay().workAreaSize

  overlayWindow = new BrowserWindow({
    width: 760,
    height: 160,
    x: Math.floor(width / 2) - 380,
    y: 60,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
    resizable: true,
    movable: true,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  overlayWindow.setContentProtection(true)
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlayWindow.setIgnoreMouseEvents(false)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    overlayWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    overlayWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function notifySettingsState(open: boolean): void {
  overlayWindow?.webContents.send('settings:state', open)
}

function createSettingsWindow(): void {
  if (settingsWindow) {
    settingsWindow.focus()
    return
  }

  settingsWindow = new BrowserWindow({
    width: 620,
    height: 800,
    minWidth: 520,
    minHeight: 600,
    resizable: true,
    title: 'Halo — Settings',
    backgroundColor: '#0f0f13',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  settingsWindow.on('closed', () => { settingsWindow = null; notifySettingsState(false) })
  notifySettingsState(true)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    settingsWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#settings`)
  } else {
    settingsWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'settings' })
  }
}

function createSessionWindow(): void {
  if (sessionWindow) {
    sessionWindow.focus()
    return
  }

  sessionWindow = new BrowserWindow({
    width: 600,
    height: 720,
    minWidth: 480,
    minHeight: 560,
    title: 'Halo — Session',
    backgroundColor: '#0f0f13',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  sessionWindow.on('closed', () => { sessionWindow = null })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    sessionWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#session`)
  } else {
    sessionWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'session' })
  }
}

// ── Provider factory ─────────────────────────────────────────────
function createProvider(type: ProviderType): TranslationProvider {
  switch (type) {
    case 'openai': return new OpenAIRealtimeProvider()
    case 'gemini':
    default:       return new GeminiLiveProvider()
  }
}

// ── IPC handlers ─────────────────────────────────────────────────

ipcMain.handle('gemini:start', async (_, opts: { provider: ProviderType; sourceLang: string; targetLang: string; source: 'mic' | 'system' }) => {
  // Key never travels from the renderer — read it from secure storage here.
  const providerType = opts.provider ?? 'gemini'
  const apiKey = getSecret(providerType === 'openai' ? 'openai' : 'gemini')
  if (!apiKey) {
    return { ok: false, error: `${providerType === 'openai' ? 'OpenAI' : 'Gemini'} API key is not set. Open settings.` }
  }

  if (provider) await provider.stop()
  await systemAudio.stop()
  await stopCandidateStt()

  // Fresh stream: clear dedupe/in-flight state (session log persists across restarts).
  interviewAssistant.reset()

  provider = createProvider(providerType)

  provider.on('transcript', (data) => {
    overlayWindow?.webContents.send('transcript:update', data)
    // Record finalized turns into the history log (both modes).
    if (data.isFinal) recordTurn(data.original, data.translated)
    // Async sidecar — detect questions and suggest answers; never blocks captions.
    interviewAssistant.consider(data.original, data.translated, data.isFinal)
  })

  provider.on('error', (msg: string) => {
    overlayWindow?.webContents.send('gemini:error', msg)
  })

  provider.on('connected', () => {
    overlayWindow?.webContents.send('provider:connected')
  })

  provider.on('disconnected', () => {
    overlayWindow?.webContents.send('provider:disconnected')
  })

  provider.on('reconnecting', (attempt: number) => {
    overlayWindow?.webContents.send('provider:reconnecting', attempt)
  })

  provider.on('stalled', () => {
    overlayWindow?.webContents.send('provider:stalled')
  })

  await provider.start({ provider: providerType, apiKey, sourceLang: opts.sourceLang, targetLang: opts.targetLang })

  // System audio:
  //  - macOS: captured here in main via AudioTee (Core Audio taps).
  //  - Windows/other: captured in the renderer via loopback and streamed over
  //    audio:chunk, so nothing to start here.
  if (opts.source === 'system' && process.platform === 'darwin') {
    try {
      await systemAudio.start(
        (pcm16) => provider?.sendAudioChunk(pcm16),
        (msg) => overlayWindow?.webContents.send('gemini:error', msg)
      )
    } catch (e: any) {
      await provider.stop()
      provider = null
      return { ok: false, error: `Sistem sesi başlatılamadı (AudioTee): ${e?.message || e?.name || 'bilinmeyen hata'}` }
    }
  }

  // Also transcribe the candidate's mic (renderer streams it over audio:chunk-mic)
  // when interview mode OR speaker-labels is on, with a system source.
  //   - interview: attach finalized utterances to the latest question (myAnswer).
  //   - speaker-labels: record them as their own "me" entries in the transcript.
  if ((interviewEnabled || speakerLabels) && opts.source === 'system') {
    try {
      candidateStt = createProvider(providerType)
      candidateStt.on('transcript', (d: { original: string; isFinal: boolean }) => {
        if (!d.isFinal) return
        if (interviewEnabled) recordCandidateAnswer(d.original)
        else recordCandidateTurn(d.original)
      })
      candidateStt.on('error', (m: string) => console.error('[candidate-stt]', m))
      await candidateStt.start({
        provider: providerType,
        apiKey,
        sourceLang: opts.sourceLang,
        targetLang: opts.sourceLang === 'auto' ? 'en' : opts.sourceLang
      })
    } catch (e) {
      console.error('[candidate-stt] start failed:', e)
      await stopCandidateStt()
    }
  }

  return { ok: true }
})

ipcMain.handle('gemini:stop', async () => {
  await systemAudio.stop()
  await stopCandidateStt()
  await provider?.stop()
  provider = null
  return { ok: true }
})

// Audio chunk: renderer mic → main → active TranslationProvider (mic source).
ipcMain.on('audio:chunk', (_event, chunk: Buffer) => {
  provider?.sendAudioChunk(chunk)
})

// Candidate mic chunk (interview + system mode) → transcription-only session.
ipcMain.on('audio:chunk-mic', (_event, chunk: Buffer) => {
  candidateStt?.sendAudioChunk(chunk)
})

ipcMain.handle('overlay:hide', () => { overlayWindow?.hide() })
ipcMain.handle('overlay:show', () => { overlayWindow?.show() })
ipcMain.handle('interview:config', (_e, cfg: { enabled: boolean; cvText: string; glossary: string; speakerLabels?: boolean; ephemeral?: boolean }) => {
  interviewEnabled = cfg.enabled
  interviewCv = cfg.cvText
  interviewGlossary = cfg.glossary || ''
  speakerLabels = !!cfg.speakerLabels
  const wasEphemeral = ephemeral
  ephemeral = !!cfg.ephemeral
  // Turning ephemeral ON: wipe what's already on disk so nothing lingers.
  if (ephemeral && !wasEphemeral) deleteSessionFile()
  applyInterviewConfig()
})

// "Delete all data" — clear the in-memory log and remove the on-disk file.
ipcMain.handle('data:purge', () => {
  sessionLog = []
  interviewAssistant.reset()
  deleteSessionFile()
  broadcast('session:update', sessionLog)
  return { ok: true }
})

// ── Secrets (API keys, encrypted at rest via OS keychain) ────────
ipcMain.handle('secrets:status', () => ({
  available: isSecureStorageAvailable(),
  ...secretStatus()
}))
// Return the decrypted key — only on explicit user action (reveal / copy in
// settings). The key stays encrypted at rest; this just hands the user back
// their own key on demand instead of keeping it in renderer storage.
ipcMain.handle('secrets:get', (_e, name: SecretName) => getSecret(name))
ipcMain.handle('secrets:set', (_e, name: SecretName, value: string) => {
  try {
    setSecret(name, value)
    if (name === 'anthropic') applyInterviewConfig()
    return { ok: true, ...secretStatus() }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Failed to store key' }
  }
})

// Manual "answer now" — force a suggestion for the latest utterance.
ipcMain.handle('interview:answer-now', () => { void interviewAssistant.forceAnswer() })

ipcMain.handle('session:open', () => { createSessionWindow() })
ipcMain.handle('session:list', () => sessionLog)
ipcMain.handle('session:clear', () => {
  sessionLog = []
  interviewAssistant.reset()
  emitSession()
})
ipcMain.handle('session:summarize', async () => {
  return interviewAssistant.summarize(sessionLog)
})
// Record the candidate's own answer for a question (their actual reply, which
// may differ from the suggested one).
ipcMain.handle('session:set-answer', (_e, index: number, text: string) => {
  const entry = sessionLog[index]
  if (entry) { entry.myAnswer = text; emitSession() }
})
// Coaching analysis of questions + the candidate's actual answers.
ipcMain.handle('session:analyze', async () => {
  return interviewAssistant.analyze(sessionLog)
})
// Export the history to a file the user picks (.md or .txt).
ipcMain.handle('session:export', async (_e, format: 'md' | 'txt') => {
  if (sessionLog.length === 0) return { ok: false, error: 'Kayıt yok.' }
  const content = format === 'md' ? sessionToMarkdown() : sessionToPlain()
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Oturumu dışa aktar',
    defaultPath: `halo-session-${stamp}.${format}`,
    filters: [{ name: format === 'md' ? 'Markdown' : 'Text', extensions: [format] }]
  })
  if (canceled || !filePath) return { ok: false }
  try { writeFileSync(filePath, content, 'utf8'); return { ok: true, path: filePath } }
  catch (e: any) { return { ok: false, error: e?.message || 'Yazılamadı' } }
})

function sessionToMarkdown(): string {
  const lines = ['# Halo — Oturum', '', `_${new Date().toLocaleString()}_`, '']
  sessionLog.forEach((e, i) => {
    lines.push(`## ${i + 1}. ${e.original || e.translated}`)
    if (e.original && e.translated && e.original !== e.translated) lines.push(`*${e.translated}*`)
    if (e.answer) lines.push('', `**💡 Önerilen:** ${e.answer}`)
    if (e.myAnswer) lines.push('', `**🎙 Senin cevabın:** ${e.myAnswer}`)
    lines.push('')
  })
  return lines.join('\n')
}
function sessionToPlain(): string {
  return sessionLog.map((e, i) => {
    let b = `${i + 1}. ${e.original || e.translated}`
    if (e.original && e.translated && e.original !== e.translated) b += `\n   (${e.translated})`
    if (e.answer) b += `\n   [Önerilen] ${e.answer}`
    if (e.myAnswer) b += `\n   [Senin cevabın] ${e.myAnswer}`
    return b
  }).join('\n\n')
}

ipcMain.handle('settings:open', () => { createSettingsWindow() })
ipcMain.handle('settings:close', () => {
  if (settingsWindow) { settingsWindow.close(); settingsWindow = null }
})

// ── App lifecycle ─────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Restore the previous session history from disk.
  loadSession()

  // macOS: trigger the system mic prompt (and surface current status in dev).
  if (process.platform === 'darwin') {
    const status = systemPreferences.getMediaAccessStatus('microphone')
    console.log('[mic] access status:', status)
    if (status !== 'granted') {
      const granted = await systemPreferences.askForMediaAccess('microphone')
      console.log('[mic] askForMediaAccess ->', granted)
    }
  }

  // Approve mic (getUserMedia) and system-audio loopback (getDisplayMedia).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media' || permission === 'display-capture')
  })

  createOverlayWindow()

  globalShortcut.register('CommandOrControl+Shift+S', () => {
    if (overlayWindow?.isVisible()) {
      overlayWindow.hide()
    } else {
      overlayWindow?.show()
    }
  })

  // Force an answer for the latest interviewer utterance (interview mode).
  globalShortcut.register('CommandOrControl+Shift+A', () => {
    void interviewAssistant.forceAnswer()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createOverlayWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  void systemAudio.stop()
  void stopCandidateStt()
  provider?.stop()
})
