import { useState } from 'react'
import type { AudioSource } from '../App'
import { qTypeLabel } from '../App'

interface Props {
  isRunning: boolean
  original: string
  translated: string
  error: string
  settingsOpen: boolean
  audioSource: AudioSource
  interviewMode: boolean
  suggestion: string
  suggestionQuestion: string
  suggestionType: string
  suggesting: boolean
  connState: '' | 'connected' | 'reconnecting' | 'stalled'
  reconnectAttempt: number
  onAnswerNow: () => void
  onToggleSource: () => void
  onStart: () => void
  onStop: () => void
  onToggleSettings: () => void
}

export default function OverlayView({
  isRunning, original, translated, error, settingsOpen, audioSource,
  interviewMode, suggestion, suggestionQuestion, suggestionType, suggesting, connState, reconnectAttempt,
  onAnswerNow, onToggleSource, onStart, onStop, onToggleSettings
}: Props) {
  const [isDragging, setIsDragging] = useState(false)

  const hasContent = original || translated

  return (
    <div
      className="overlay-root"
      style={{ WebkitAppRegion: isDragging ? 'drag' : 'no-drag' } as any}
    >
      {/* Drag handle — top bar */}
      <div
        className="drag-handle"
        onMouseEnter={() => setIsDragging(true)}
        onMouseLeave={() => setIsDragging(false)}
      >
        <span className="app-name">halo</span>
        <div className="controls">
          <button
            className={`btn-icon source ${isRunning ? 'locked' : ''}`}
            onClick={onToggleSource}
            disabled={isRunning}
            title={
              isRunning
                ? 'Kaynağı değiştirmek için önce durdur'
                : audioSource === 'mic'
                  ? 'Kaynak: Mikrofon (kendi sesin) — sistem sesine geç'
                  : 'Kaynak: Sistem sesi (karşı taraf) — mikrofona geç'
            }
          >
            {audioSource === 'mic' ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z"/>
                <path d="M17 11a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/>
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4.03v8.06A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06A9 9 0 0 0 14 3.23z"/>
              </svg>
            )}
          </button>
          <button
            className={`btn-toggle ${isRunning ? 'running' : 'idle'}`}
            onClick={isRunning ? onStop : onStart}
            title={
              isRunning
                ? 'Çeviriyi durdur (⌘⇧S)'
                : `Çeviriyi başlat — ${audioSource === 'mic' ? 'mikrofonu' : 'sistem sesini'} dinler (⌘⇧S)`
            }
          >
            {isRunning ? (
              <svg width="10" height="10" viewBox="0 0 10 10">
                <rect x="1" y="1" width="3" height="8" rx="0.5" fill="currentColor"/>
                <rect x="6" y="1" width="3" height="8" rx="0.5" fill="currentColor"/>
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10">
                <polygon points="1,0 10,5 1,10" fill="currentColor"/>
              </svg>
            )}
          </button>
          {interviewMode && isRunning && (
            <button
              className="btn-icon answer-now"
              onClick={onAnswerNow}
              title="Son soruyu şimdi cevapla (⌘⇧A)"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5z"/>
              </svg>
            </button>
          )}
          <button
            className="btn-icon"
            onClick={() => window.subtl.openSession()}
            title="Geçmiş — transkript ve (interview modunda) önerilen cevaplar"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 6h16M4 12h16M4 18h10"/>
            </svg>
          </button>
          <button
            className={`btn-icon ${settingsOpen ? 'active' : ''}`}
            onClick={onToggleSettings}
            title={settingsOpen ? 'Ayarları kapat' : 'Ayarları aç'}
          >
            {settingsOpen ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18"/>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54A.484.484 0 0 0 13.4 2h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L1.81 8.47c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Transcript area */}
      <div className="transcript-area">
        {error && (
          <p className="error-text">{error}</p>
        )}

        {!hasContent && !error && (
          <p className="placeholder-text">
            {isRunning ? 'Listening...' : 'Press ▶ to start translation'}
          </p>
        )}

        {hasContent && (
          <div className="transcript-lines">
            {original && (
              <p className="line-original">{original}</p>
            )}
            {translated && (
              <p className="line-translated">{translated}</p>
            )}
          </div>
        )}
      </div>

      {/* Interview suggestion panel (Phase 4) — async, never blocks captions.
          The panel only appears when the AI judged the question is directed at
          the candidate, so its header is an explicit "this is for you" alert. */}
      {interviewMode && (suggesting || suggestion) && (
        <div className="suggestion-panel alert">
          <div className="suggestion-label">
            🎯 Bu soru sana yöneltildi
            {suggestionType && <span className="qtype-badge">{qTypeLabel(suggestionType)}</span>}
          </div>
          {suggestionQuestion && (
            <p className="suggestion-question">{suggestionQuestion}</p>
          )}
          {suggesting && !suggestion
            ? <p className="suggestion-thinking">Cevap hazırlanıyor…</p>
            : <p className="suggestion-text">{suggestion}</p>}
        </div>
      )}

      {/* Connection indicator */}
      {isRunning && (
        <div className={`live-dot ${connState}`}>
          <span className={`dot ${connState === 'reconnecting' ? 'amber' : connState === 'stalled' ? 'red' : 'pulse'}`} />
          <span className="live-label">
            {connState === 'reconnecting'
              ? `RECONNECTING${reconnectAttempt ? ` (${reconnectAttempt})` : ''}`
              : connState === 'stalled'
                ? 'STALLED'
                : 'LIVE'}
          </span>
        </div>
      )}
    </div>
  )
}
