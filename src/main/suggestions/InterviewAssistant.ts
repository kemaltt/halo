import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { EventEmitter } from 'events'

// Interview suggestions run ASYNC and must never block the translation stream.
// Text-reasoning only (never in the audio→text path). The user can pick which
// model powers it: Claude Haiku (Anthropic) or Gemini Flash (Google).
const CLAUDE_MODEL = 'claude-haiku-4-5'
const GEMINI_MODEL = 'gemini-2.0-flash'
const OPENAI_MODEL = 'gpt-4o-mini'

// How long the interviewer must pause before we treat the accumulated speech as
// a complete utterance worth evaluating. The Gemini live model has no reliable
// turn boundary, so we debounce on silence instead of trusting isFinal alone.
const SILENCE_MS = 1100
// Don't bother evaluating trivially short fragments.
const MIN_LEN = 8
// How many recent interviewer turns to keep as context for the judge.
const HISTORY_MAX = 6

export type AssistantProvider = 'claude' | 'gemini' | 'openai'

export interface InterviewConfig {
  enabled: boolean
  provider: AssistantProvider
  apiKey: string
  cvText: string
  glossary?: string
}

export interface Suggestion {
  question: string
  original: string
  translated: string
  answer: string
  type?: string // question category (behavioral, technical, …)
}

interface Utterance {
  original: string
  translated: string
}

interface Verdict {
  answer_needed: boolean
  question?: string
  answer?: string
  question_type?: string // behavioral | technical | system-design | situational | background | other
}

/**
 * Decides — with the model, not a regex — whether the interviewer's latest
 * utterance is actually a question/request DIRECTED AT THE CANDIDATE that wants
 * a spoken answer, using recent conversation context. Only then does it produce
 * an answer. Rhetorical questions, thinking-aloud, small talk, and transitions
 * are left alone, so the overlay stays quiet unless there's something to say.
 */
export class InterviewAssistant extends EventEmitter {
  private config: InterviewConfig = { enabled: false, provider: 'claude', apiKey: '', cvText: '' }
  private anthropic: Anthropic | null = null
  private genai: GoogleGenerativeAI | null = null
  private openaiKey = '' // OpenAI uses the REST API directly (no SDK)
  private clientKey = '' // provider+key signature, to rebuild only on change
  private epoch = 0

  // Rolling state for the current/just-finished utterance.
  private latestOriginal = ''
  private latestTranslated = ''
  private silenceTimer: NodeJS.Timeout | null = null

  // Evaluation pipeline: one call at a time, but never lose the newest turn.
  private inFlight = false
  private pending: Utterance | null = null
  private lastKey = ''

  // Recent interviewer turns, oldest→newest, as conversational context.
  private history: string[] = []

  setConfig(cfg: InterviewConfig): void {
    this.config = cfg
    const sig = `${cfg.provider}:${cfg.apiKey}`
    if (cfg.apiKey && sig !== this.clientKey) {
      this.anthropic = cfg.provider === 'claude' ? new Anthropic({ apiKey: cfg.apiKey }) : null
      this.genai = cfg.provider === 'gemini' ? new GoogleGenerativeAI(cfg.apiKey) : null
      this.clientKey = sig
    }
    if (!cfg.apiKey) {
      this.anthropic = null
      this.genai = null
      this.clientKey = ''
    }
  }

  /** Whether the selected assistant provider has a usable client. */
  private ready(): boolean {
    return this.config.provider === 'gemini' ? !!this.genai : !!this.anthropic
  }

  /** Single text-generation entry point — dispatches to Claude or Gemini. */
  private async generate(system: string, user: string, maxTokens: number, json = false): Promise<string> {
    if (this.config.provider === 'gemini') {
      if (!this.genai) throw new Error('Gemini anahtarı ayarlı değil')
      const model = this.genai.getGenerativeModel({
        model: GEMINI_MODEL,
        systemInstruction: system,
        generationConfig: { maxOutputTokens: maxTokens, ...(json ? { responseMimeType: 'application/json' } : {}) }
      })
      const res = await model.generateContent(user)
      return (res.response.text() || '').trim()
    }
    if (!this.anthropic) throw new Error('Anthropic anahtarı ayarlı değil')
    const resp = await this.anthropic.messages.create({
      model: CLAUDE_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }]
    })
    return resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text).join('').trim()
  }

  reset(): void {
    this.epoch++ // invalidate any in-flight request so its late result is dropped
    this.latestOriginal = ''
    this.latestTranslated = ''
    this.inFlight = false
    this.pending = null
    this.lastKey = ''
    this.history = []
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null }
  }

  /**
   * Feed a transcript update from the other participant (the interviewer).
   * `original`/`translated` are the cumulative text of the current turn, so we
   * just snapshot the latest and let a silence debounce decide when the turn is
   * complete.
   */
  consider(original: string, translated: string, isFinal: boolean): void {
    if (!this.config.enabled || !this.ready()) return

    this.latestOriginal = (original || '').trim()
    this.latestTranslated = (translated || '').trim()

    const probe = this.latestOriginal || this.latestTranslated
    if (probe.length < MIN_LEN) return

    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null }

    if (isFinal) {
      this.flush()
    } else {
      this.silenceTimer = setTimeout(() => this.flush(), SILENCE_MS)
    }
  }

  private flush(): void {
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null }
    this.maybeEvaluate({ original: this.latestOriginal, translated: this.latestTranslated })
  }

  private maybeEvaluate(u: Utterance): void {
    const key = u.original || u.translated
    if (!key || key.length < MIN_LEN) return
    if (key === this.lastKey) return                  // already handled this exact utterance
    if (this.inFlight) { this.pending = u; return }   // keep only the newest while busy

    this.lastKey = key
    void this.evaluate(u)
  }

  private async evaluate(u: Utterance): Promise<void> {
    this.inFlight = true
    const myEpoch = this.epoch
    try {
      const verdict = await this.judge(u)
      if (myEpoch !== this.epoch) return // session was reset/restarted meanwhile

      // Keep the interviewer's turn as context regardless of the verdict, so
      // follow-up questions ("and how did you handle that?") are understood.
      this.pushHistory(u.original || u.translated)

      if (verdict.answer_needed && verdict.answer) {
        this.emit('suggestion', {
          question: verdict.question || u.original || u.translated,
          original: u.original,
          translated: u.translated,
          answer: verdict.answer,
          type: verdict.question_type
        } as Suggestion)
      }
    } catch (e: any) {
      if (myEpoch === this.epoch) this.emit('error', e?.message || 'suggestion failed')
    } finally {
      this.inFlight = false
      const next = this.pending
      this.pending = null
      if (next && this.epoch === myEpoch) this.maybeEvaluate(next)
    }
  }

  /** One call: classify (is this for the candidate?) AND draft the answer. */
  private async judge(u: Utterance): Promise<Verdict> {
    const context = this.history.length
      ? `Recent interviewer speech (oldest→newest):\n${this.history.join('\n')}\n\n`
      : ''

    const system =
      `You assist a candidate during a LIVE job interview. You receive ONLY the ` +
      `INTERVIEWER's transcribed speech (with a translation). Decide whether the ` +
      `LATEST utterance is something the candidate is expected to answer out loud ` +
      `right now — a genuine question or request directed at the candidate.\n\n` +
      `Treat as NOT needing an answer: rhetorical questions, the interviewer ` +
      `thinking aloud, restating or clarifying their own point, small talk, ` +
      `transitions ("okay, let's see…"), or anything not actually asking the ` +
      `candidate for information.\n\n` +
      `If no answer is needed, reply EXACTLY:\n{"answer_needed": false}\n\n` +
      `If an answer IS needed, reply:\n` +
      `{"answer_needed": true, "question": "<the question in its original language>", ` +
      `"question_type": "<one of: behavioral | technical | system-design | situational | background | other>", ` +
      `"answer": "<a strong, specific first-person answer (\\"I …\\") the candidate ` +
      `can say aloud, 3-5 sentences, grounded in the CV, in the SAME language as the ` +
      `question>"}\n\n` +
      `Output ONLY the JSON object. No prose, no code fences.\n\n` +
      `Candidate CV:\n${this.config.cvText || '(no CV provided — give a strong generic answer)'}` +
      this.glossaryBlock()

    const user =
      `${context}Latest utterance:\n` +
      `[original] ${u.original || '(none)'}\n` +
      `[translation] ${u.translated || '(none)'}`

    return parseVerdict(await this.generate(system, user, 700, true))
  }

  private pushHistory(turn: string): void {
    if (!turn) return
    this.history.push(turn)
    if (this.history.length > HISTORY_MAX) this.history = this.history.slice(-HISTORY_MAX)
  }

  /** User glossary appended to every prompt so names/terms stay correct. */
  private glossaryBlock(): string {
    const g = (this.config.glossary || '').trim()
    return g
      ? `\n\nKnown names/terms — use these EXACT spellings and keep brand/product names ` +
        `untranslated wherever they appear:\n${g}`
      : ''
  }

  /**
   * Force an answer for the most recent interviewer utterance, bypassing the
   * question-gate (the candidate pressed "answer now" because the AI stayed
   * quiet). User-initiated, so it takes priority and ignores the in-flight lock.
   */
  async forceAnswer(): Promise<void> {
    if (!this.config.enabled || !this.ready()) {
      this.emit('error', 'Interview modu kapalı ya da asistan anahtarı ayarlı değil.')
      return
    }
    const u: Utterance = { original: this.latestOriginal, translated: this.latestTranslated }
    if (!(u.original || u.translated)) {
      this.emit('error', 'Cevaplanacak bir şey yok — henüz konuşma yakalanmadı.')
      return
    }

    const myEpoch = this.epoch
    this.emit('thinking', u.original || u.translated)
    try {
      const answer = await this.draftAnswer(u)
      if (myEpoch !== this.epoch) return
      this.pushHistory(u.original || u.translated)
      if (answer) {
        this.emit('suggestion', {
          question: u.original || u.translated,
          original: u.original,
          translated: u.translated,
          answer
        } as Suggestion)
      }
    } catch (e: any) {
      if (myEpoch === this.epoch) this.emit('error', e?.message || 'suggestion failed')
    }
  }

  /** Draft an answer unconditionally (used by forceAnswer). */
  private async draftAnswer(u: Utterance): Promise<string> {
    const context = this.history.length
      ? `Recent interviewer speech (oldest→newest):\n${this.history.join('\n')}\n\n`
      : ''
    const system =
      `You are an interview coach. The candidate has asked you to draft an answer to the ` +
      `interviewer's latest utterance — whether or not it is phrased as a direct question. ` +
      `Using the CV, write a strong, specific first-person answer ("I …") the candidate can ` +
      `say aloud: 3-5 sentences, grounded in the CV, in the SAME language as the utterance. ` +
      `Output only the answer — no preamble, no quotes.\n\n` +
      `Candidate CV:\n${this.config.cvText || '(no CV provided — give a strong generic answer)'}` +
      this.glossaryBlock()
    const user =
      `${context}Interviewer's latest utterance:\n` +
      `[original] ${u.original || '(none)'}\n` +
      `[translation] ${u.translated || '(none)'}`
    return this.generate(system, user, 700)
  }

  /** Summarize the conversation/interview from the accumulated history log. */
  async summarize(entries: { original: string; translated: string; answer?: string }[]): Promise<string> {
    if (!this.ready()) throw new Error('Asistan anahtarı ayarlı değil')
    if (entries.length === 0) return 'Nothing was captured in this session yet.'

    const hasAnswers = entries.some(e => e.answer)

    const transcript = entries
      .map((e, i) => {
        const line = `${i + 1}. ${e.original || e.translated}` +
          (e.original && e.translated && e.original !== e.translated ? `  → ${e.translated}` : '')
        return e.answer ? `${line}\n   Suggested answer: ${e.answer}` : line
      })
      .join('\n\n')

    const system = hasAnswers
      ? `You are an interview debrief assistant. Given the questions asked during a job interview ` +
        `and the answers that were suggested, write a concise post-interview summary for the candidate.\n` +
        `Cover: (1) topics the interviewer probed, (2) the questions asked, (3) how they were addressed, ` +
        `(4) strengths to lean on and gaps to prepare for next time. Use clear headings and short bullets. ` +
        `Reply in the candidate's CV language if discernible, otherwise English.\n\n` +
        `Candidate CV:\n${this.config.cvText || '(no CV provided)'}`
      : `You are a meeting-notes assistant. Given the transcript of a conversation (each line is what ` +
        `the other participant said, with its translation), write a concise summary: main topics, key ` +
        `points, decisions, and any action items or open questions. Use clear headings and short bullets. ` +
        `Reply in the translation's language if discernible, otherwise English.`

    return this.generate(system + this.glossaryBlock(), transcript, 1024)
  }

  /**
   * Coaching analysis of the interview: for each question, evaluate the answer
   * the candidate ACTUALLY gave (myAnswer; falls back to the suggested one),
   * then give an overall verdict — strengths, weaknesses, and what to improve.
   */
  async analyze(
    entries: { original: string; translated: string; answer?: string; myAnswer?: string; qtype?: string }[]
  ): Promise<string> {
    if (!this.ready()) throw new Error('Asistan anahtarı ayarlı değil')
    const answered = entries.filter(e => e.myAnswer?.trim() || e.answer?.trim())
    if (answered.length === 0) {
      return 'Henüz analiz edilecek cevap yok. Sorulara kendi cevabını gir (ya da önerilen cevabı kullan), sonra tekrar dene.'
    }

    const transcript = entries
      .map((e, i) => {
        const q = `${i + 1}. Soru${e.qtype ? ` [${e.qtype}]` : ''}: ${e.original || e.translated}` +
          (e.original && e.translated && e.original !== e.translated ? `  (çeviri: ${e.translated})` : '')
        const mine = e.myAnswer?.trim()
        const sugg = e.answer?.trim()
        const ans = mine
          ? `   Adayın cevabı: ${mine}`
          : sugg
            ? `   (Adayın kendi cevabı kaydedilmedi; önerilen cevap referans: ${sugg})`
            : `   (Cevap kaydedilmedi.)`
        return `${q}\n${ans}`
      })
      .join('\n\n')

    const system =
      `You are a senior interview coach reviewing a candidate's job interview. You are given ` +
      `each question and the answer the CANDIDATE ACTUALLY GAVE (when their own answer is missing, ` +
      `a suggested answer is shown only as reference — judge it more leniently and note it wasn't ` +
      `confirmed). Produce an honest, constructive debrief:\n` +
      `1. Per-question: a one-line verdict (✅ strong / ⚠️ okay / ❌ weak) + what was good and what ` +
      `to improve, with a concrete better phrasing where useful. For behavioral questions, check ` +
      `whether the answer follows STAR (Situation, Task, Action, Result).\n` +
      `2. Communication: comment on filler words ("ee", "şey", "yani", "um", "like"), answer length ` +
      `(too short / rambling), and clarity/structure — quote a couple of examples from the answers.\n` +
      `3. Overall: top strengths, main weaknesses/risks, and 3-5 concrete, prioritized action items ` +
      `to prepare for next time.\n` +
      `Be specific and grounded in the CV; avoid generic filler. Use clear headings and short bullets. ` +
      `Reply in the language of the candidate's answers (Turkish if they are Turkish), otherwise English.\n\n` +
      `Candidate CV:\n${this.config.cvText || '(no CV provided)'}` +
      this.glossaryBlock()

    return this.generate(system, transcript, 1600)
  }
}

/** Pull a JSON verdict out of the model reply, tolerating fences/stray prose. */
function parseVerdict(text: string): Verdict {
  if (!text) return { answer_needed: false }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fence ? fence[1] : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return { answer_needed: false }
  try {
    const parsed = JSON.parse(body.slice(start, end + 1))
    return {
      answer_needed: !!parsed.answer_needed,
      question: typeof parsed.question === 'string' ? parsed.question : undefined,
      answer: typeof parsed.answer === 'string' ? parsed.answer : undefined,
      question_type: typeof parsed.question_type === 'string' ? parsed.question_type : undefined
    }
  } catch {
    return { answer_needed: false }
  }
}
