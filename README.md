# Halo

Real-time meeting translation overlay for macOS. Halo captures the other
participant's speech in any meeting (Google Meet, Zoom, Teams, …), shows **live
captions** translated into your language **plus the original transcript in a
different color**, in a blur overlay that is **invisible to screen sharing** — so
your eye contact isn't broken and the overlay doesn't show up when you share your
screen.

Optionally, in **interview mode**, Halo listens to the interviewer, detects
questions actually directed at you, and drafts example answers grounded in your
CV — while also transcribing your own spoken answers for an after-the-fact
coaching analysis.

> Display name **Halo**; internal package id stays `subtl` (codename: "subtitle"
> + "subtle").

---

## Features

- **Live translation overlay** — dual transcript: original (Color A) + translation (Color B), low-latency.
- **Invisible to screen sharing** — `setContentProtection(true)`; always-on-top, frameless, blurred.
- **Two audio sources** — your **mic** (own voice) or **system audio** (the other participant, via Core Audio taps — no screen-recording permission).
- **Auto / manual language** — source auto-detects; manual selection improves accuracy.
- **Interview mode**
  - An AI judge decides whether the latest utterance is a real question *for you* and drafts an answer — staying silent on rhetorical/thinking-aloud speech. **Pick the model:** Claude Haiku, Gemini Flash, or OpenAI gpt-4o-mini.
  - **🎯 "Bu soru sana yöneltildi"** alert + a **question-type** badge (behavioral/technical/…) + suggested answer in the overlay.
  - Manual override: force an answer for the latest utterance (`⌘⇧A`).
  - Captures **your own spoken answers** (separate mic transcription) and runs an **Analyze** pass — per-question ✅/⚠️/❌ feedback, STAR/filler/length coaching, plus overall strengths, gaps, and action items.
- **Session history** — persisted locally, with speaker labels ("Sen" vs "Karşı taraf"), export to `.md`/`.txt`, and **Summary**/**Analyze**.
- **Custom glossary** — your names/jargon fed to all AI text steps for correct spelling.
- **Mic picker + level test** — choose your input device and verify it before starting (no API cost).
- **Resilient streams** — WebSocket reconnect with exponential backoff + "stalled" indicator.
- **Privacy-first** — keys encrypted in the macOS Keychain (`safeStorage`); transcripts local-only with an **ephemeral** (no-disk) mode and **delete-all-data**; audio goes only to the provider you chose, with your own key.

---

## Requirements

- **macOS 14.2+** (system-audio capture uses the Core Audio taps API). Mic-only works on older versions.
- **Node.js 18+**.
- API keys (you supply your own):
  - **Gemini** — <https://aistudio.google.com/apikey> (default translation provider)
  - or **OpenAI** — <https://platform.openai.com/api-keys> (alternative provider)
  - **Anthropic** — <https://console.anthropic.com/settings/keys> (only for interview mode)

---

## Quick start (development)

```bash
npm install      # also downloads the bundled AudioTee binary
npm run dev       # electron-vite dev with HMR
```

On first run macOS will ask for:

- **Microphone** access (for your own voice / candidate capture).
- **System Audio Recording** — System Settings → Privacy & Security → *Screen & System Audio Recording* → **"System Audio Recording Only"** (not the top screen-recording section). Grant it to the app/terminal and restart.

Then open **Settings** (gear icon), enter your API key(s), pick your target
language, and press ▶ to start.

### Shortcuts

- `⌘⇧S` — show / hide the overlay
- `⌘⇧A` — force an interview answer for the latest utterance

---

## How it works

```
mic (renderer AudioWorklet) / system audio (main AudioTee)
   └─► Gemini Live WS (gemini-3.5-live-translate)
         ├─► input transcript  → overlay (original)
         ├─► output transcript → overlay (translation)
         └─► utterance settles → Claude Haiku judge (+ history + CV)
               └─ if directed at you → answer suggestion
```

- **Main process** owns system-audio capture (AudioTee → 16 kHz PCM), the
  translation provider WebSocket, encrypted secrets, and the Haiku interview
  sidecar.
- **Renderer** is the React overlay; the mic is captured with an `AudioWorklet`
  (off the main thread) and streamed as PCM16 over IPC.
- The **translation path stays pure and fast**; interview suggestions run
  asynchronously and never block captions. Claude is text-only — never in the
  audio→text path.
- In interview mode the candidate's mic runs a **second, transcription-only**
  session so your actual answers are recorded for the analysis.

---

## Build & distribute

```bash
npm run build     # type-check + build to out/
npm run dist      # package a macOS .dmg (electron-builder)
```

For others to run a packaged `.dmg`, the app must be **code-signed** (Apple
Developer ID) and **notarized** — otherwise Gatekeeper blocks it. The bundled
AudioTee binary inherits the app's signature (`asarUnpack` + hardened-runtime
entitlements are configured). The Mac App Store is not viable (its sandbox is
incompatible with system-audio capture).

To just let a friend run it locally, send the **source** (not `node_modules` /
`out`); they run `npm install && npm run dev` and enter their own keys.

---

## Tech stack

Electron · React · TypeScript · Vite (electron-vite) · `audiotee` (Core Audio
taps) · Gemini Live Translate (or OpenAI realtime) · Claude Haiku 4.5.

## Project structure

```
src/
├── main/                       # main process
│   ├── index.ts                # windows, content protection, IPC, shortcuts
│   ├── secrets.ts              # safeStorage-encrypted API keys
│   ├── audio/SystemAudioCapture.ts
│   ├── providers/              # TranslationProvider + Gemini/OpenAI
│   └── suggestions/InterviewAssistant.ts
├── preload/index.ts            # contextBridge `window.subtl`
└── renderer/                   # React overlay / settings / session UI
```

See [`CLAUDE.md`](./CLAUDE.md) for the full architecture and design rules.

---

## Notes & limitations

- `setContentProtection` hides the overlay in Meet/Teams/Chime and all
  browser-based sharing. The **native macOS Zoom client may still show it** —
  prefer Meet-in-browser for testing.
- Interview mode runs **two concurrent live sessions** (≈2× API usage) and works
  best with **headphones** (speakers bleed the interviewer's voice into your mic
  transcript).
- **Use responsibly.** An overlay that is invisible to screen sharing and feeds
  live answers may violate an interviewer's expectations or a platform's terms.
  Halo is intended for accessibility (real-time translation across a language
  barrier) and practice/preparation.

## License

MIT
