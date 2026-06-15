import { useState, useEffect, useRef } from 'react'
import type { SessionEntry } from '../env'

export default function SessionView() {
  const [entries, setEntries] = useState<SessionEntry[]>([])
  const [pending, setPending] = useState('')   // question currently being answered
  const [summary, setSummary] = useState('')
  const [summarizing, setSummarizing] = useState(false)
  const [analysis, setAnalysis] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [error, setError] = useState('')
  const bottomRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    window.subtl.getSession().then(setEntries)
    const unsub = window.subtl.onSessionUpdate?.((list) => {
      setEntries(list)
      setPending('')   // answer arrived → drop the live "thinking" card
    })
    // Live "thinking" card while Claude drafts the next answer.
    const unsubThinking = window.subtl.onSuggestionThinking?.((q) => setPending(q))
    return () => { unsub?.(); unsubThinking?.() }
  }, [])

  // Auto-scroll to the newest entry as the interview runs.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries.length, pending])

  const summarize = async () => {
    setSummarizing(true)
    setError('')
    try {
      setSummary(await window.subtl.summarizeSession())
    } catch (e: any) {
      setError(e?.message || 'Summary failed')
    } finally {
      setSummarizing(false)
    }
  }

  const analyze = async () => {
    setAnalyzing(true)
    setError('')
    try {
      setAnalysis(await window.subtl.analyzeSession())
    } catch (e: any) {
      setError(e?.message || 'Analysis failed')
    } finally {
      setAnalyzing(false)
    }
  }

  const clearAll = async () => {
    await window.subtl.clearSession()
    setSummary('')
    setAnalysis('')
  }

  const copyTranscript = () => {
    const text = entries
      .map((e, i) => {
        let block = `${i + 1}. ${e.original || e.translated}` +
          (e.original && e.translated && e.original !== e.translated ? `\n   (${e.translated})` : '')
        if (e.answer) block += `\n   💡 ${e.answer}`
        if (e.myAnswer) block += `\n   🎙 ${e.myAnswer}`
        return block
      })
      .join('\n\n')
    window.subtl.copyText(text)
  }

  const hasMyAnswers = entries.some(e => e.myAnswer)

  return (
    <div className="session-root">
      <div className="session-header">
        <span className="settings-logo">halo</span>
        <h1>Geçmiş</h1>
        <span className="session-count">{entries.length} kayıt</span>
      </div>

      <div className="session-body">
        {entries.length === 0 && !pending && !summary && !analysis && (
          <p className="placeholder-text">
            Konuşma kaydı burada birikir — çeviriyi başlatınca her cümle eklenir.
          </p>
        )}

        {entries.map((e, i) => (
          <div className="qa-card" key={i}>
            <div className="qa-q">
              <span className="qa-num">{i + 1}</span>
              <span className="qa-orig">{e.original || e.translated}</span>
            </div>
            {e.original && e.translated && e.translated !== e.original && (
              <div className="qa-trans">{e.translated}</div>
            )}
            {e.answer && (
              <div className="qa-answer">
                <span className="qa-tag suggest">💡 Önerilen</span> {e.answer}
              </div>
            )}
            {e.myAnswer && (
              <div className="qa-answer mine">
                <span className="qa-tag mine">🎙 Senin cevabın</span> {e.myAnswer}
              </div>
            )}
          </div>
        ))}

        {pending && (
          <div className="qa-card pending">
            <div className="qa-q">
              <span className="qa-num">Q{entries.length + 1}</span>
              <span className="qa-orig">{pending}</span>
            </div>
            <div className="qa-answer thinking">Thinking…</div>
          </div>
        )}

        <div ref={bottomRef} />

        {error && <p className="error-text">{error}</p>}

        {analysis && (
          <div className="summary-card analysis">
            <div className="summary-label">🧠 Performans analizi</div>
            <pre className="summary-text">{analysis}</pre>
          </div>
        )}

        {summary && (
          <div className="summary-card">
            <div className="summary-label">📋 Özet</div>
            <pre className="summary-text">{summary}</pre>
          </div>
        )}
      </div>

      <div className="session-actions">
        <button className="btn-ghost" onClick={copyTranscript} disabled={entries.length === 0}>
          Kopyala
        </button>
        <button className="btn-ghost danger" onClick={clearAll} disabled={entries.length === 0}>
          Temizle
        </button>
        <button
          className="btn-ghost"
          onClick={summarize}
          disabled={entries.length === 0 || summarizing}
        >
          {summarizing ? 'Özetleniyor…' : 'Özet'}
        </button>
        <button
          className="btn-save"
          onClick={analyze}
          disabled={entries.length === 0 || analyzing}
          title={hasMyAnswers ? 'Senin cevaplarını değerlendir' : 'Cevaplar üzerinden değerlendir'}
        >
          {analyzing ? 'Analiz ediliyor…' : 'Analiz et'}
        </button>
      </div>
    </div>
  )
}
