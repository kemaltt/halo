import { useState, useEffect, useRef } from 'react'
import OverlayView from './components/OverlayView'
import SettingsView from './components/SettingsView'
import SessionView from './components/SessionView'
import { createPcmWorkletNode, type PcmWorkletHandle } from './audio/pcm16Worklet'

const isSettings = window.location.hash === '#settings'
const isSession = window.location.hash === '#session'

export type ProviderType = 'gemini' | 'openai'
export type AudioSource = 'mic' | 'system'

// API keys are NOT part of Settings — they live encrypted in the main process
// and are referenced only by KeyStatus (set / not-set), never read into the
// renderer's persistent storage.
export interface Settings {
  provider: ProviderType
  sourceLang: string
  targetLang: string
  micDeviceId: string   // '' = system default input
  // Interview mode (Phase 4)
  interviewMode: boolean
  cvText: string
}

export interface KeyStatus {
  available: boolean
  gemini: boolean
  openai: boolean
  anthropic: boolean
}

const EMPTY_KEY_STATUS: KeyStatus = { available: true, gemini: false, openai: false, anthropic: false }

function readSettings(): Settings {
  return {
    provider:      (localStorage.getItem('subtl_provider') as ProviderType) || 'gemini',
    sourceLang:    localStorage.getItem('subtl_source_lang') || 'auto',
    targetLang:    localStorage.getItem('subtl_target_lang') || 'tr-TR',
    micDeviceId:   localStorage.getItem('subtl_mic_device') || '',
    interviewMode: localStorage.getItem('subtl_interview_mode') === '1',
    cvText:        localStorage.getItem('subtl_cv_text') || ''
  }
}

function pushInterviewConfig(s: Settings): void {
  window.subtl.setInterviewConfig({
    enabled: s.interviewMode,
    cvText: s.cvText
  })
}

const DEFAULT_SETTINGS: Settings = readSettings()

// Microphone (own voice). On macOS this is the 'mic' source; in interview mode
// it also feeds the candidate transcription.
async function getMicStream(): Promise<MediaStream> {
  const deviceId = localStorage.getItem('subtl_mic_device') || ''
  return navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
      sampleRate: 16000,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  })
}

// System audio (other participant) on Windows/other: Electron loopback via
// getDisplayMedia (macOS uses main-process AudioTee instead, so this isn't
// called there). We drop the unused video track and keep only the audio.
async function getSystemLoopbackStream(): Promise<MediaStream> {
  await window.subtl.enableLoopback()
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    stream.getVideoTracks().forEach(t => { t.stop(); stream.removeTrack(t) })
    if (stream.getAudioTracks().length === 0) {
      throw new Error('Sistem sesi alınamadı (loopback boş) — ses paylaşımına izin verin.')
    }
    return stream
  } finally {
    await window.subtl.disableLoopback()
  }
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [isRunning, setIsRunning] = useState(false)
  const [original, setOriginal] = useState('')
  const [translated, setTranslated] = useState('')
  const [error, setError] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [suggestion, setSuggestion] = useState('')
  const [suggestionQuestion, setSuggestionQuestion] = useState('')
  const [suggesting, setSuggesting] = useState(false)
  const [keyStatus, setKeyStatus] = useState<KeyStatus>(EMPTY_KEY_STATUS)
  // Provider connection: '' idle, 'connected', 'reconnecting' (n), 'stalled'
  const [connState, setConnState] = useState<'' | 'connected' | 'reconnecting' | 'stalled'>('')
  const [reconnectAttempt, setReconnectAttempt] = useState(0)
  // 'mic' = own voice (testing) · 'system' = other participant (Phase 2)
  const [audioSource, setAudioSource] = useState<AudioSource>(
    () => (localStorage.getItem('subtl_audio_source') as AudioSource) || 'mic'
  )

  const audioCtxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const workletRef = useRef<PcmWorkletHandle | null>(null)

  // Candidate mic capture (interview + system mode) — own answers via STT.
  const micCtxRef = useRef<AudioContext | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const micWorkletRef = useRef<PcmWorkletHandle | null>(null)

  const teardownCandidateMic = () => {
    micWorkletRef.current?.dispose(); micWorkletRef.current = null
    micStreamRef.current?.getTracks().forEach(t => t.stop()); micStreamRef.current = null
    micCtxRef.current?.close().catch(() => {}); micCtxRef.current = null
  }

  useEffect(() => {
    const unsub = window.subtl.onTranscript((data) => {
      setOriginal(data.original)
      setTranslated(data.translated)
    })
    const unsubErr = window.subtl.onError((msg) => setError(msg))

    // Settings live in a separate window; pick up saved changes via the
    // storage event (fires in other same-origin windows) so the overlay
    // doesn't keep a stale API key until the app is restarted.
    const onStorage = () => setSettings(readSettings())
    window.addEventListener('storage', onStorage)

    // Track the settings window so the gear button can toggle to ✕.
    const unsubState = window.subtl.onSettingsState?.(setSettingsOpen)

    // Interview suggestions (Phase 4) — async, arrive after captions.
    const unsubThinking = window.subtl.onSuggestionThinking?.((q) => {
      setSuggesting(true)
      setSuggestion('')           // drop the prior answer so the panel shows "thinking"
      setSuggestionQuestion(q || '') // the utterance being answered
    })
    const unsubSuggest = window.subtl.onSuggestion?.((data) => {
      setSuggesting(false)
      setSuggestion(data.answer)
      setSuggestionQuestion(data.question || '')
    })

    // Push current interview config to main on startup.
    pushInterviewConfig(readSettings())

    // Which API keys are set (kept in secure main-process storage).
    window.subtl.getKeyStatus().then(setKeyStatus).catch(() => {})

    // Provider connection status → overlay indicator.
    const unsubConn = window.subtl.onProviderStatus?.((s) => {
      if (s.state === 'connected') { setConnState('connected'); setReconnectAttempt(0) }
      else if (s.state === 'reconnecting') { setConnState('reconnecting'); setReconnectAttempt(s.attempt || 0) }
      else if (s.state === 'stalled') setConnState('stalled')
      else setConnState(prev => (prev === 'connected' ? '' : prev)) // disconnected
    })

    return () => {
      unsubConn?.()
      unsub?.(); unsubErr?.(); unsubState?.(); unsubThinking?.(); unsubSuggest?.()
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const startTranslation = async () => {
    // Read fresh — settings may have just changed in the settings window.
    const current = readSettings()
    setSettings(current)

    setError('')
    setOriginal('')
    setTranslated('')
    setSuggestion('')   // clear the previous answer on (re)start
    setSuggestionQuestion('')
    setSuggesting(false)

    // Stage label so a failure tells us WHERE it broke (provider WS, audio
    // capture/permission, or worklet load) instead of a bare "aborted".
    let stage: 'provider' | 'audio' | 'worklet' = 'provider'
    try {
      // Main reads the API key from secure storage; it returns ok:false if unset.
      // For 'system', main also starts AudioTee — so a failure there surfaces here.
      const res = await window.subtl.startTranslation({
        provider:   current.provider,
        sourceLang: current.sourceLang,
        targetLang: current.targetLang,
        source:     audioSource
      })
      if (!res?.ok) throw new Error(res?.error || 'API key is not set. Open settings.')

      // Capture for the MAIN provider (interviewer/translation):
      //  - 'mic' source → renderer microphone
      //  - 'system' on non-macOS → renderer loopback (macOS captures system
      //    audio in the main process via AudioTee, so nothing runs here)
      const captureSystemHere = audioSource === 'system' && window.subtl.platform !== 'darwin'
      if (audioSource === 'mic' || captureSystemHere) {
        stage = 'audio'
        const stream = audioSource === 'mic' ? await getMicStream() : await getSystemLoopbackStream()

        // 16 kHz AudioContext resamples the source down to the 16 kHz PCM the
        // providers expect.
        const audioCtx = new AudioContext({ sampleRate: 16000 })
        if (audioCtx.state === 'suspended') await audioCtx.resume()
        const source = audioCtx.createMediaStreamSource(stream)

        stage = 'worklet'
        // AudioWorklet (dedicated audio thread) replaces the deprecated
        // main-thread ScriptProcessorNode. 1024 samples @16kHz ≈ 64 ms/frame.
        const worklet = await createPcmWorkletNode(audioCtx, 1024, (pcm16) => {
          window.subtl.sendAudioChunk(pcm16)
        })

        source.connect(worklet.node)
        // The worklet emits no audio output (silent), so routing to destination
        // keeps it pulled by the graph without echoing the captured audio.
        worklet.node.connect(audioCtx.destination)

        audioCtxRef.current = audioCtx
        streamRef.current = stream
        workletRef.current = worklet
      }

      // Interview + system: also capture the candidate's own voice (mic) into a
      // separate transcription-only session. Non-fatal if the mic is unavailable
      // — the meeting translation keeps working either way.
      if (audioSource === 'system' && current.interviewMode) {
        try {
          const micStream = await getMicStream()
          const micCtx = new AudioContext({ sampleRate: 16000 })
          if (micCtx.state === 'suspended') await micCtx.resume()
          const micSrc = micCtx.createMediaStreamSource(micStream)
          const micWorklet = await createPcmWorkletNode(micCtx, 1024, (pcm16) => {
            window.subtl.sendMicChunk(pcm16)
          })
          micSrc.connect(micWorklet.node)
          micWorklet.node.connect(micCtx.destination)
          micCtxRef.current = micCtx
          micStreamRef.current = micStream
          micWorkletRef.current = micWorklet
        } catch (micErr) {
          console.warn('[candidate-mic] capture unavailable:', micErr)
        }
      }

      setIsRunning(true)
    } catch (err: any) {
      // Tear down anything that did start so an aborted attempt doesn't leak an
      // open provider WS or a live audio stream.
      workletRef.current?.dispose(); workletRef.current = null
      streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current = null
      await audioCtxRef.current?.close().catch(() => {}); audioCtxRef.current = null
      teardownCandidateMic()
      await window.subtl.stopTranslation().catch(() => {})
      setIsRunning(false)

      const msg = err?.message || err?.name || 'bilinmeyen hata'
      if (stage === 'provider') {
        // Main returns an already-descriptive message (key missing / AudioTee).
        setError(msg)
      } else {
        const label = stage === 'audio'
          ? (audioSource === 'system' ? 'Sistem sesi alınamadı' : 'Mikrofon erişimi reddedildi/iptal edildi')
          : 'Ses işleme (AudioWorklet) başlatılamadı'
        setError(`${label}: ${msg}`)
      }
    }
  }

  const stopTranslation = async () => {
    workletRef.current?.dispose()
    workletRef.current = null
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    await audioCtxRef.current?.close()
    audioCtxRef.current = null
    teardownCandidateMic()
    await window.subtl.stopTranslation()
    setConnState('')
    setReconnectAttempt(0)
    setIsRunning(false)
  }

  const saveSettings = (s: Settings) => {
    setSettings(s)
    localStorage.setItem('subtl_provider',       s.provider)
    localStorage.setItem('subtl_source_lang',    s.sourceLang)
    localStorage.setItem('subtl_target_lang',    s.targetLang)
    localStorage.setItem('subtl_mic_device',     s.micDeviceId)
    localStorage.setItem('subtl_interview_mode', s.interviewMode ? '1' : '0')
    localStorage.setItem('subtl_cv_text',        s.cvText)
    pushInterviewConfig(s)
  }

  if (isSettings) {
    return <SettingsView settings={settings} keyStatus={keyStatus} onSave={saveSettings} />
  }

  if (isSession) {
    return <SessionView />
  }

  return (
    <OverlayView
      isRunning={isRunning}
      original={original}
      translated={translated}
      error={error}
      settingsOpen={settingsOpen}
      audioSource={audioSource}
      interviewMode={settings.interviewMode}
      suggestion={suggestion}
      suggestionQuestion={suggestionQuestion}
      suggesting={suggesting}
      connState={connState}
      reconnectAttempt={reconnectAttempt}
      onAnswerNow={() => window.subtl.answerNow()}
      onToggleSource={() => {
        if (isRunning) return // can't switch the source mid-stream
        setAudioSource(prev => {
          const next: AudioSource = prev === 'mic' ? 'system' : 'mic'
          localStorage.setItem('subtl_audio_source', next)
          return next
        })
      }}
      onStart={startTranslation}
      onStop={stopTranslation}
      onToggleSettings={() =>
        settingsOpen ? window.subtl.closeSettings() : window.subtl.openSettings()
      }
    />
  )
}
