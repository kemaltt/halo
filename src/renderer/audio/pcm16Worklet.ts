// AudioWorklet replacement for the deprecated ScriptProcessorNode.
//
// The PCM16 conversion runs on the dedicated audio render thread (NOT the
// main/UI thread) — lower latency and no UI jank on the caption path
// (CLAUDE.md "Latency over polish").
//
// The processor module is loaded as a Vite `?url` asset. Do NOT switch this to
// a blob:/data: URL — under Electron's file:// origin the worklet module fetch
// is blocked and throws "The user aborted a request" (a fetch AbortError).
import workletUrl from './pcm16-processor.js?url'

export interface PcmWorkletHandle {
  node: AudioWorkletNode
  dispose: () => void
}

/**
 * Wire a MediaStream source → PCM16 frames. The caller connects
 * `handle.node` into the graph and calls `handle.dispose()` on teardown.
 *
 * @param frameSize samples per posted frame. At a 16 kHz AudioContext,
 *        1024 ≈ 64 ms — a quarter of the old 4096-sample (256 ms) buffer.
 */
export async function createPcmWorkletNode(
  audioCtx: AudioContext,
  frameSize: number,
  onChunk: (pcm16: ArrayBuffer) => void
): Promise<PcmWorkletHandle> {
  await audioCtx.audioWorklet.addModule(workletUrl)

  const node = new AudioWorkletNode(audioCtx, 'pcm16-worklet', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    processorOptions: { frameSize }
  })

  node.port.onmessage = (e) => onChunk(e.data as ArrayBuffer)

  return {
    node,
    dispose: () => {
      node.port.onmessage = null
      try { node.disconnect() } catch { /* already disconnected */ }
    }
  }
}
