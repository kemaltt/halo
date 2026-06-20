# CLAUDE.md — Subtl

Real-time meeting translation overlay for macOS. Captures the other participant's
speech in any meeting (Meet/Zoom/etc.), shows **live captions** translated into the
user's language **plus the original transcript in a different color**, in a
**blur overlay that is invisible to screen sharing** (so eye contact isn't broken).
Optional: upload a CV/skills file → in interview mode, suggest example answers to
detected questions.

> Display name: **Halo**. Internal/package id stays `subtl` (codename: "subtitle" +
> "subtle") — kept stable so the IPC bridge (`window.subtl`) and the userData path
> (where safeStorage keys live) don't move.

---

## Status
Phases 1–5 substantially implemented (mic + system audio, dual transcript, interview
mode, polish). macOS-only; Windows scaffolding present (OS-branched capture) but untested.

**Recent additions:** session history persisted to `userData/halo-session.json` + `.md/.txt`
export; mic device picker + live level/test; custom (non-native) dropdowns; user **glossary**
fed to all AI text steps; interview **question-type** badge + coaching analysis (STAR/filler/
length); **speaker labels** ("Sen" vs "Karşı taraf", opt-in dual capture); **privacy** card
(ephemeral no-disk mode, "delete all data"); centralized **API Keys** card; multi-provider
interview assistant (Claude/Gemini/OpenAI).

## Critical metric
**Latency.** Every architectural choice favors lower latency on the translation path.

---

## Tech Stack
- **App:** Electron + React + TypeScript + Vite
- **Audio capture (macOS):**
  - **Mic (own voice):** renderer `getUserMedia` → `AudioWorklet` (`src/renderer/audio/`) converts to 16 kHz PCM16 (replaced the deprecated `ScriptProcessorNode`) → IPC `audio:chunk` → provider.
  - **System audio (other participant) — auto by OS** (`window.subtl.platform`):
    - **macOS:** `audiotee` (AudioTee.js) in the **main process** (`src/main/audio/SystemAudioCapture.ts`). 16 kHz request → 16-bit PCM straight to the provider; no renderer round-trip, no `getDisplayMedia`, audio-only permission (`NSAudioCaptureUsageDescription`). ESM-only → dynamic `import()`. macOS 14.2+. Main starts it only when `process.platform === 'darwin'`.
    - **Windows/other:** Electron **loopback** via `electron-audio-loopback` in the **renderer** (`getSystemLoopbackStream` → `getDisplayMedia` → AudioWorklet → `audio:chunk`). Same provider pipeline as the mic path.
  - **Candidate mic (interview mode):** in interview + system-audio mode, the renderer ALSO captures the mic into a **second, transcription-only provider session** (`audio:chunk-mic` → `candidateStt` in main). Used to record what the candidate actually answered — read only its `original` text, no translation. Two concurrent live sessions = ~2× API usage; headphones recommended (speaker bleed).
  - **Fallback (still wired, unused):** `electron-audio-loopback`.
- **STT + translation:** Gemini 3.5 Live Translate (`gemini-3.5-live-translate-preview`) over WebSocket. Single session yields **both input (original) and output (translated) transcripts**.
  - Swappable alternative: OpenAI realtime (`gpt-4o-realtime-preview` + Whisper) behind the same interface.
- **Interview answer suggestions (text-reasoning, user-pickable provider):** Claude Haiku 4.5 / Gemini 2.0 Flash / OpenAI gpt-4o-mini, async, CV + glossary as context. Selected in Settings; uses that provider's key. Single `InterviewAssistant.generate()` dispatches to the three (Anthropic SDK / Google SDK / OpenAI REST via fetch).

## Hard rule — model roles
- **No model is hardcoded into the audio→text path except a realtime speech model.** Translation/STT layer = Gemini Live **or** OpenAI Realtime (provider abstraction). Claude has no audio input / no realtime STT, so it can NEVER be a translation provider — this was requested and declined.
- **Interview suggestions are text-only** and may run on Claude, Gemini, or OpenAI (user choice). Text-reasoning only; never in the audio→text path.

---

## Data Flow
```
mic (renderer AudioWorklet) / system audio (main AudioTee)
   └─► Gemini Live WS (gemini-3.5-live-translate)
         ├─► input transcript  → overlay, Color A (original, dim/gray)
         ├─► output transcript → overlay, Color B (translation, bright/primary)
         └─► (utterance settles, ASYNC) → Claude Haiku 4.5 judge (+ history + CV)
               ├─ not directed at candidate → stay silent
               └─ directed at candidate → overlay panel: "🎯 sana soruldu" + answer
```
In interview mode the candidate's own mic runs a parallel transcription-only
session; finalized candidate utterances attach to the latest question as
`myAnswer`. The session window shows `💡 Önerilen` (AI) vs `🎙 Senin cevabın`
(candidate), and **Analiz et** runs a Haiku coaching debrief over the questions +
the candidate's actual answers (per-question ✅/⚠️/❌ + overall strengths/gaps/
action items). **Özet** is the lighter summary.

**Rule:** the translation stream stays pure and fast. Interview suggestions run
**asynchronously** in the background and must never block or delay live captions.
The judge replaces the old keyword regex: a single Haiku call classifies whether
the utterance is a real question *for the candidate* and drafts the answer in one
shot. Manual override: `⌘⇧A` (or the overlay ⚡ button) forces an answer for the
latest utterance.

---

## Key Constraints / Non-negotiables
1. **macOS first.** Don't add Windows-specific code paths until Phase 6.
2. **Latency over polish** on the caption path.
3. **Overlay must be invisible to screen sharing** — `setContentProtection(true)`.
4. **Provider abstraction:** never hardcode Gemini calls in UI/components; go through a `TranslationProvider` interface.
5. **Secrets:** user-supplied keys, encrypted at rest via Electron `safeStorage` (OS keychain) in the main process (`src/main/secrets.ts`) — never in renderer `localStorage`, never committed. Renderer learns only set/not-set status; the raw key is returned only on explicit reveal/copy.
6. **Dual transcript + auto/manual language:** source language defaults to auto-detect; manual selection passes a language hint to improve ASR accuracy.

---

## Overlay Window (Electron)
```js
new BrowserWindow({
  transparent: true,
  frame: false,
  alwaysOnTop: true,
  hasShadow: false,
});
win.setContentProtection(true);
win.setAlwaysOnTop(true, 'screen-saver');
win.setVisibleOnAllWorkspaces(true);
```
- Blur: macOS `vibrancy` or semi-transparent window + CSS `backdrop-filter: blur()`.
- Position near the camera so the user's gaze stays up.

### Gotchas
- `setContentProtection(true)` hides the overlay in Teams, Chime, Google Meet, and all browser-based sharing. **macOS native Zoom client is the exception** — its capture pipeline may still show the overlay. Prefer Meet-in-browser for testing.
- Audio permissions differ by path: the loopback (ScreenCaptureKit) path triggers a screen-recording permission + menu-bar indicator and needs a (1×1) screen capture to exist; AudioTee.js / Core Audio Taps needs only the "System Audio Recording" permission, no screen capture. Set the right entitlements + Info.plist usage strings for whichever ships.

---

## Structure (actual)
```
subtl/
├── CLAUDE.md
├── electron.vite.config.ts        # main / preload / renderer build (asarUnpack for AudioTee bin)
├── build/entitlements.mac.plist   # mic + allow inherited AudioTee binary
├── src/
│   ├── main/                      # main process
│   │   ├── index.ts               # windows, content protection, IPC, lifecycle, global shortcuts
│   │   ├── secrets.ts             # safeStorage-encrypted API keys
│   │   ├── audio/SystemAudioCapture.ts   # AudioTee (system audio → PCM)
│   │   ├── providers/             # TranslationProvider (base: reconnect/backoff) + Gemini/OpenAI
│   │   └── suggestions/InterviewAssistant.ts  # Haiku judge + forceAnswer + summarize
│   ├── preload/index.ts           # contextBridge `window.subtl`
│   └── renderer/                  # React overlay UI
│       ├── App.tsx                # overlay/settings/session windows by hash
│       ├── components/            # OverlayView, SettingsView, SessionView
│       └── audio/                 # AudioWorklet (mic → PCM16) + processor
```

## Dev Commands
- `npm run dev` — electron-vite dev (HMR).
- `npm run build` — type-check + build to `out/`.
- `npm run dist` — package a macOS `.dmg` (electron-builder).
- Type-check only: `npx tsc -p tsconfig.node.json --noEmit` (main/preload) and `npx tsc -p tsconfig.web.json --noEmit` (renderer).

## Coding Conventions
- TypeScript strict mode. Functional React + hooks (matches existing experience).
- Keep provider-specific code behind `TranslationProvider`; UI stays provider-agnostic.
- Handle WS reconnect/backoff and "stream stalled" states explicitly (shared in the `TranslationProvider` base).
- Color tokens for Color A (original) / Color B (translation) centralized, not inline.
- Surfaces: the **overlay** (captions) stays minimal/high-contrast; **settings/session** windows are the opaque, modern "configuration" surface — don't mix the two.

## Repo hygiene
- `.gitignore` excludes `node_modules/`, `out/`, `dist/`, `*.tsbuildinfo`, and Vite/electron-vite temp configs (`*.timestamp-*.mjs`, `electron.vite.config.*.mjs`).
- **No secrets in the repo or in `.env`** — API keys live in the OS keychain via `safeStorage` (`subtl-secrets.json` under userData, not the project). Sharing the code = send source only; the recipient runs `npm install` and enters their own keys.

---

## Build Phases
1. ~~**MVP skeleton:** content-protected overlay → mic → Gemini Live → captions + language picker.~~ ✅
2. ~~**System audio:** other participant's voice.~~ ✅ — shipped on **AudioTee.js** (main-process PCM), not loopback.
3. ~~**Dual-display:** original (Color A) + translation (Color B).~~ ✅
4. ~~**Interview mode:** CV + Haiku sidecar (async).~~ ✅ — AI judge ("directed at candidate?") + manual `⌘⇧A`.
5. ~~**Polish:** show/hide hotkey, reconnect/stalled states, settings.~~ ✅ (compact/wide modes still open).
6. **Windows port.** — not started.

## Open Questions
- ~~Final audio-layer choice.~~ **Gemini Live** is the default; OpenAI realtime kept behind the interface.
- ~~ScreenCaptureKit system-audio bridge.~~ **AudioTee.js** (no hand-written native code).
- ~~Question detection: heuristic vs. classifier.~~ **Haiku judge** with conversation context.
- ~~API key strategy.~~ **User-supplied, `safeStorage`-encrypted.**
- Remaining: compact/wide overlay modes; pin/verify Electron version for packaging; sound/visual cue + question-type label for interview alerts.

