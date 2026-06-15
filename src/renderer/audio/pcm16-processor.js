// AudioWorklet processor — runs on the dedicated audio render thread.
// Converts Float32 mono samples to 16-bit PCM and posts fixed-size frames to
// the main thread as a transferable ArrayBuffer.
//
// Loaded via `addModule()` with a Vite `?url` asset (NOT a blob: URL): a blob:
// module fetch is blocked under Electron's file:// origin and surfaces as
// "The user aborted a request" (a fetch AbortError).
class Pcm16Worklet extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this._frame = (options.processorOptions && options.processorOptions.frameSize) || 1024
    this._buf = new Int16Array(this._frame)
    this._n = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true
    const ch = input[0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      const s = ch[i] < -1 ? -1 : ch[i] > 1 ? 1 : ch[i]
      this._buf[this._n++] = s < 0 ? s * 0x8000 : s * 0x7fff
      if (this._n === this._frame) {
        // slice(0) copies into a fresh buffer we can transfer without
        // detaching the reusable accumulator.
        const out = this._buf.slice(0)
        this.port.postMessage(out.buffer, [out.buffer])
        this._n = 0
      }
    }
    return true
  }
}

registerProcessor('pcm16-worklet', Pcm16Worklet)
