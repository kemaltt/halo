import { useState, useEffect, useRef } from 'react'
import type { Settings, ProviderType, KeyStatus } from '../App'
import type { SecretName } from '../env'

// Custom dropdown — styled trigger + popover list, so the open menu matches the
// dark theme (native <select> popups are OS-rendered and can't be styled).
interface DropOption { value: string; label: string }
function Dropdown({ value, options, onChange, ariaLabel }: {
  value: string; options: DropOption[]; onChange: (v: string) => void; ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const selected = options.find(o => o.value === value)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])

  return (
    <div className={`dropdown ${open ? 'open' : ''}`} ref={ref}>
      <button type="button" className="dropdown-trigger" aria-label={ariaLabel} onClick={() => setOpen(o => !o)}>
        <span className="dropdown-value">{selected?.label ?? '—'}</span>
        <svg className="dropdown-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="dropdown-menu" role="listbox">
          {options.map((o, i) => (
            <button
              key={o.value || i}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`dropdown-item ${o.value === value ? 'selected' : ''}`}
              onClick={() => { onChange(o.value); setOpen(false) }}
            >
              <span>{o.label}</span>
              {o.value === value && <span className="dropdown-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Microphone picker + live level meter / test. Runs locally (no API/cost);
// also triggers the OS mic-permission prompt, which fills in device labels.
function MicField({ deviceId, onChange }: { deviceId: string; onChange: (id: string) => void }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [testing, setTesting] = useState(false)
  const [level, setLevel] = useState(0)
  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const rafRef = useRef<number>(0)

  const refreshDevices = async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices()
      setDevices(list.filter(d => d.kind === 'audioinput'))
    } catch { /* ignore */ }
  }

  const stop = () => {
    cancelAnimationFrame(rafRef.current)
    streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current = null
    ctxRef.current?.close().catch(() => {}); ctxRef.current = null
    setTesting(false); setLevel(0)
  }

  useEffect(() => { void refreshDevices(); return () => stop() }, [])

  const test = async () => {
    if (testing) { stop(); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { ideal: deviceId } } : true
      })
      streamRef.current = stream
      await refreshDevices() // labels are available now that permission is granted
      const ctx = new AudioContext(); ctxRef.current = ctx
      const analyser = ctx.createAnalyser(); analyser.fftSize = 512
      ctx.createMediaStreamSource(stream).connect(analyser)
      const data = new Uint8Array(analyser.frequencyBinCount)
      const tick = () => {
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v }
        setLevel(Math.min(1, Math.sqrt(sum / data.length) * 2.5))
        rafRef.current = requestAnimationFrame(tick)
      }
      setTesting(true); tick()
    } catch { stop() } // permission denied / no device
  }

  return (
    <div className="field">
      <label>Mikrofon</label>
      <Dropdown
        ariaLabel="Mikrofon"
        value={deviceId}
        onChange={onChange}
        options={[
          { value: '', label: 'Varsayılan giriş' },
          ...devices.map((d, i) => ({ value: d.deviceId, label: d.label || `Mikrofon ${i + 1}` }))
        ]}
      />
      <div className="mic-test">
        <button type="button" className="btn-ghost" onClick={test}>
          {testing ? 'Durdur' : 'Test et'}
        </button>
        <div className="level-bar"><div className="level-fill" style={{ width: `${Math.round(level * 100)}%` }} /></div>
      </div>
      <p className="hint">Test'e basıp konuşun; çubuk oynuyorsa mikrofon çalışıyor.</p>
    </div>
  )
}

const LANGUAGES = [
  { code: 'auto', label: '🔍 Auto-detect' },
  { code: 'tr-TR', label: '🇹🇷 Turkish' },
  { code: 'en-US', label: '🇺🇸 English (US)' },
  { code: 'en-GB', label: '🇬🇧 English (UK)' },
  { code: 'de-DE', label: '🇩🇪 German' },
  { code: 'fr-FR', label: '🇫🇷 French' },
  { code: 'es-ES', label: '🇪🇸 Spanish' },
  { code: 'it-IT', label: '🇮🇹 Italian' },
  { code: 'pt-BR', label: '🇧🇷 Portuguese (BR)' },
  { code: 'nl-NL', label: '🇳🇱 Dutch' },
  { code: 'pl-PL', label: '🇵🇱 Polish' },
  { code: 'ru-RU', label: '🇷🇺 Russian' },
  { code: 'ar-SA', label: '🇸🇦 Arabic' },
  { code: 'zh-CN', label: '🇨🇳 Chinese (Simplified)' },
  { code: 'ja-JP', label: '🇯🇵 Japanese' },
  { code: 'ko-KR', label: '🇰🇷 Korean' },
]

interface ApiKeyFieldProps {
  label: string
  name: SecretName      // which stored key this field manages
  isSet: boolean        // a key is already saved (in secure storage)
  value: string         // the buffer being typed (empty = no change)
  placeholder: string
  helpHref: string
  helpLabel: string
  editing: boolean
  onChange: (v: string) => void
  onEdit: () => void
}

function ApiKeyField({
  label, name, isSet, value, placeholder, helpHref, helpLabel, editing, onChange, onEdit
}: ApiKeyFieldProps) {
  const [reveal, setReveal] = useState(false)
  const [revealed, setRevealed] = useState('') // decrypted key, fetched on demand
  const [copied, setCopied] = useState(false)

  const help = (
    <p className="hint">
      <a href={helpHref} target="_blank">{helpLabel}</a>
    </p>
  )

  // Locked view — the key is fetched (decrypted in main) only when the user
  // clicks reveal or copy; it is never kept in the renderer otherwise.
  if (isSet && !editing) {
    const toggleReveal = async () => {
      if (reveal) { setReveal(false); setRevealed(''); return }
      const k = await window.subtl.getKey(name)
      setRevealed(k); setReveal(true)
    }
    const copy = async () => {
      const k = revealed || await window.subtl.getKey(name)
      window.subtl.copyText(k)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
    return (
      <div className="field">
        <label>{label}</label>
        <div className="key-locked">
          <span className={`key-value ${reveal ? '' : 'masked'}`}>
            {reveal && revealed ? revealed : '•'.repeat(24)}
          </span>
          <div className="key-actions">
            <button title={reveal ? 'Gizle' : 'Göster'} onClick={toggleReveal}>{reveal ? '🙈' : '👁'}</button>
            <button title={copied ? 'Kopyalandı' : 'Kopyala'} onClick={copy}>{copied ? '✓' : '⧉'}</button>
            <button title="Değiştir" onClick={() => { setReveal(false); setRevealed(''); onEdit() }}>✎</button>
          </div>
        </div>
        {help}
      </div>
    )
  }

  // Edit view — typing a new key; saved encrypted on Save Settings.
  return (
    <div className="field">
      <label>{label}</label>
      <div className="key-edit">
        <input
          type={reveal ? 'text' : 'password'}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={isSet ? 'Yeni anahtar gir (boş = değişiklik yok)' : placeholder}
          className="input"
          autoFocus
        />
        <button
          className="key-eye"
          title={reveal ? 'Gizle' : 'Göster'}
          onClick={() => setReveal(r => !r)}
        >
          {reveal ? '🙈' : '👁'}
        </button>
      </div>
      {help}
    </div>
  )
}

interface Props {
  settings: Settings
  keyStatus: KeyStatus
  onSave: (s: Settings) => void
}

export default function SettingsView({ settings, keyStatus, onSave }: Props) {
  const [form, setForm] = useState<Settings>(settings)
  const [status, setStatus] = useState<KeyStatus>(keyStatus)
  const [saved, setSaved] = useState(false)

  // Typed buffers for new keys (empty = leave the stored key unchanged).
  const [geminiKey, setGeminiKey] = useState('')
  const [openaiKey, setOpenaiKey] = useState('')
  const [anthropicKey, setAnthropicKey] = useState('')

  // Start in edit mode only when no key is saved yet for that provider.
  const [editingGemini, setEditingGemini] = useState(!keyStatus.gemini)
  const [editingOpenai, setEditingOpenai] = useState(!keyStatus.openai)
  const [editingAnthropic, setEditingAnthropic] = useState(!keyStatus.anthropic)
  const [keyError, setKeyError] = useState('')

  // The keyStatus prop may still be the empty placeholder when this window
  // mounts (App fetches it asynchronously, in a different window). Fetch the
  // real status here so saved keys show the locked "set" view, not empty inputs.
  useEffect(() => {
    window.subtl.getKeyStatus().then(s => {
      setStatus(s)
      setEditingGemini(!s.gemini)
      setEditingOpenai(!s.openai)
      setEditingAnthropic(!s.anthropic)
    }).catch(() => {})
  }, [])

  const set = <K extends keyof Settings>(key: K, val: Settings[K]) =>
    setForm(f => ({ ...f, [key]: val }))

  const handleSave = async () => {
    onSave(form)

    // Persist any newly-typed keys to secure storage (skip empty buffers).
    const pending: [SecretName, string][] = [
      ['gemini', geminiKey.trim()],
      ['openai', openaiKey.trim()],
      ['anthropic', anthropicKey.trim()]
    ].filter(([, v]) => v !== '') as [SecretName, string][]

    try {
      let latest = status
      for (const [name, value] of pending) {
        const res = await window.subtl.setKey(name, value)
        if (!res.ok) { setKeyError(res.error || 'Anahtar kaydedilemedi'); return }
        latest = { available: true, gemini: !!res.gemini, openai: !!res.openai, anthropic: !!res.anthropic }
      }
      setStatus(latest)
      setGeminiKey(''); setOpenaiKey(''); setAnthropicKey('')
      setEditingGemini(!latest.gemini)
      setEditingOpenai(!latest.openai)
      setEditingAnthropic(!latest.anthropic)
    } catch (e: any) {
      setKeyError(e?.message || 'Anahtar kaydedilemedi')
      return
    }

    setSaved(true)
    setTimeout(() => window.subtl.closeSettings(), 500)
  }

  const onCvFile = async (file: File | undefined) => {
    if (!file) return
    const text = await file.text()
    set('cvText', text)
  }

  return (
    <div className="settings-root">
      <div className="settings-header">
        <span className="settings-logo">halo</span>
        <h1>Settings</h1>
      </div>

      <div className="settings-body">

        {!status.available && (
          <p className="error-text">
            OS güvenli depolama (Keychain) kullanılamıyor — anahtarlar şu an kaydedilemez.
          </p>
        )}
        {keyError && <p className="error-text">{keyError}</p>}

        {/* ── Provider + API key ── */}
        <section className="settings-card">
        <div className="field">
          <label>Translation Provider</label>
          <div className="provider-tabs">
            {(['gemini', 'openai'] as ProviderType[]).map(p => (
              <button
                key={p}
                className={`provider-tab ${form.provider === p ? 'active' : ''}`}
                onClick={() => set('provider', p)}
              >
                {p === 'gemini' ? '✦ Gemini' : '◈ OpenAI'}
              </button>
            ))}
          </div>
          <p className="hint">
            {form.provider === 'gemini'
              ? 'gemini-3.5-live-translate-preview — single session, lowest latency.'
              : 'gpt-4o-realtime-preview + Whisper STT — proven quality.'}
          </p>
        </div>

        {/* ── API Key (encrypted at rest; locked when saved) ── */}
        {form.provider === 'gemini' && (
          <ApiKeyField
            label="Gemini API Key"
            name="gemini"
            isSet={status.gemini}
            value={geminiKey}
            placeholder="AIza..."
            helpHref="https://aistudio.google.com/apikey"
            helpLabel="aistudio.google.com"
            editing={editingGemini}
            onChange={setGeminiKey}
            onEdit={() => setEditingGemini(true)}
          />
        )}

        {form.provider === 'openai' && (
          <ApiKeyField
            label="OpenAI API Key"
            name="openai"
            isSet={status.openai}
            value={openaiKey}
            placeholder="sk-..."
            helpHref="https://platform.openai.com/api-keys"
            helpLabel="platform.openai.com"
            editing={editingOpenai}
            onChange={setOpenaiKey}
            onEdit={() => setEditingOpenai(true)}
          />
        )}
        </section>

        {/* ── Languages ── */}
        <section className="settings-card">
        <div className="field">
          <label>Source Language (speaker)</label>
          <Dropdown
            ariaLabel="Source language"
            value={form.sourceLang}
            onChange={v => set('sourceLang', v)}
            options={LANGUAGES.map(l => ({ value: l.code, label: l.label }))}
          />
          <p className="hint">Manual selection improves accuracy (especially DE/EN mix)</p>
        </div>

        <div className="field">
          <label>Target Language (your language)</label>
          <Dropdown
            ariaLabel="Target language"
            value={form.targetLang}
            onChange={v => set('targetLang', v)}
            options={LANGUAGES.filter(l => l.code !== 'auto').map(l => ({ value: l.code, label: l.label }))}
          />
        </div>
        </section>

        {/* ── Audio / microphone ── */}
        <section className="settings-card">
          <MicField deviceId={form.micDeviceId} onChange={v => set('micDeviceId', v)} />
        </section>

        {/* ── Glossary / terms ── */}
        <section className="settings-card">
          <div className="field">
            <label>Sözlük / Terimler</label>
            <textarea
              className="input cv-textarea"
              placeholder="Her satıra bir isim/terim — örn:&#10;Kubernetes&#10;Anthropic&#10;Kemal Tütüncü"
              value={form.glossary}
              onChange={e => set('glossary', e.target.value)}
              rows={4}
            />
            <p className="hint">AI'ın cevap/analiz/özetlerinde bu isim/terimleri doğru yazması için bağlam (canlı altyazıyı etkilemez).</p>
          </div>
        </section>

        {/* ── Speaker labels ── */}
        <section className="settings-card">
          <div className="field">
            <label className="toggle-row">
              <span>Konuşmacı etiketleri</span>
              <button
                type="button"
                role="switch"
                aria-checked={form.speakerLabels}
                className={`switch ${form.speakerLabels ? 'on' : ''}`}
                onClick={() => set('speakerLabels', !form.speakerLabels)}
              >
                <span className="switch-knob" />
              </button>
            </label>
            <p className="hint">Sistem sesi modunda mikrofonunu da dinler; geçmişte konuşmalar "Karşı taraf" ve "Sen" diye ayrılır. İki canlı oturum açar (≈2× API). Interview modunda zaten ayrıdır.</p>
          </div>
        </section>

        {/* ── Interview mode (Phase 4) ── */}
        <section className="settings-card accent">
        <div className="field">
          <label className="toggle-row">
            <span>Interview Mode</span>
            <button
              type="button"
              role="switch"
              aria-checked={form.interviewMode}
              className={`switch ${form.interviewMode ? 'on' : ''}`}
              onClick={() => set('interviewMode', !form.interviewMode)}
            >
              <span className="switch-knob" />
            </button>
          </label>
          <p className="hint">Detects the interviewer's questions and suggests answers (Claude Haiku, async).</p>
        </div>

        {form.interviewMode && (
          <>
            <ApiKeyField
              label="Anthropic API Key"
              name="anthropic"
              isSet={status.anthropic}
              value={anthropicKey}
              placeholder="sk-ant-..."
              helpHref="https://console.anthropic.com/settings/keys"
              helpLabel="console.anthropic.com"
              editing={editingAnthropic}
              onChange={setAnthropicKey}
              onEdit={() => setEditingAnthropic(true)}
            />

            <div className="field">
              <label>CV / Skills</label>
              <input
                type="file"
                accept=".txt,.md,.markdown,text/plain"
                className="file-input"
                onChange={e => onCvFile(e.target.files?.[0])}
              />
              <textarea
                className="input cv-textarea"
                placeholder="Paste your CV / skills here, or upload a .txt/.md file above…"
                value={form.cvText}
                onChange={e => set('cvText', e.target.value)}
                rows={5}
              />
              <p className="hint">
                {form.cvText ? `${form.cvText.length} characters` : 'Used as context for answer suggestions.'}
              </p>
            </div>
          </>
        )}
        </section>

        {/* ── Shortcut ── */}
        <section className="settings-card">
        <div className="field">
          <label>Shortcut</label>
          <div className="kbd-row">
            <kbd>⌘</kbd><kbd>⇧</kbd><kbd>S</kbd>
            <span className="hint-inline">— Show / Hide overlay</span>
          </div>
        </div>
        </section>

        <button
          className={`btn-save ${saved ? 'saved' : ''}`}
          onClick={handleSave}
        >
          {saved ? '✓ Saved' : 'Save Settings'}
        </button>
      </div>
    </div>
  )
}
