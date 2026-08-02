// 24-bit, 2-channel packed PCM, matching lib/wav.ts's interleave() output.
const FRAME_BYTES = 6

/**
 * Converts a block of packed 24-bit stereo PCM to separate 16-bit L/R
 * channels for the MP3 encoder, which only takes 16-bit input. Rounds via
 * `(sample + 128) >> 8` rather than a plain shift: adding half the divisor
 * before the right-shift turns truncation into round-to-nearest. That can
 * push a near-full-scale sample one past the 16-bit ceiling, so the result
 * is still clamped.
 */
export function convert24to16(bytes: Uint8Array): {
  l: Int16Array<ArrayBuffer>
  r: Int16Array<ArrayBuffer>
} {
  const frames = Math.floor(bytes.length / FRAME_BYTES)
  const l = new Int16Array(frames)
  const r = new Int16Array(frames)
  for (let i = 0, o = 0; i < frames; i++, o += FRAME_BYTES) {
    let a = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)
    let b = bytes[o + 3] | (bytes[o + 4] << 8) | (bytes[o + 5] << 16)
    if (a & 0x800000) a -= 0x1000000
    if (b & 0x800000) b -= 0x1000000
    a = (a + 128) >> 8
    b = (b + 128) >> 8
    l[i] = a > 32767 ? 32767 : a < -32768 ? -32768 : a
    r[i] = b > 32767 ? 32767 : b < -32768 ? -32768 : b
  }
  return { l, r }
}

const WAV_HEADER_BYTES = 44
// Whole encoder frames (1152 samples) per block, about 1.7 MB at 24-bit
// stereo — large enough to be efficient, small enough that bounding to one
// block in flight keeps memory sane on a phone for a long take.
const BLOCK_BYTES = 1152 * 256 * FRAME_BYTES

export interface EncodeMp3Options {
  bitrate: number
  onProgress?: (fraction: number) => void
}

/**
 * Streams a stored 24-bit WAV out of OPFS in blocks, converts each to
 * 16-bit, and feeds it to the MP3 worker — waiting for the worker's
 * acknowledgement before sending the next block. Without that backpressure
 * the reader outruns the encoder (which runs at roughly 3-10x realtime) and
 * a long take queues the entire file as Int16 in worker memory, which is
 * how this crashes on a phone instead of just taking a while.
 */
export function encodeMp3(
  wavBlob: Blob,
  sampleRate: number,
  options: EncodeMp3Options,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const worker = new Worker('/mp3-worker.js')
    let ack: (() => void) | null = null

    worker.onerror = () => {
      worker.terminate()
      reject(new Error('encoder failed to start'))
    }
    worker.onmessage = (e) => {
      const m = e.data
      if (m.type === 'ready' || m.type === 'progress') {
        if (m.type === 'progress') options.onProgress?.(m.done / wavBlob.size)
        if (ack) {
          const resolveAck = ack
          ack = null
          resolveAck()
        }
      }
      if (m.type === 'done') {
        worker.terminate()
        resolve(m.blob)
      }
    }
    const wait = () => new Promise<void>((r) => (ack = r))

    void (async () => {
      const started = wait()
      worker.postMessage({ type: 'init', sampleRate, bitrate: options.bitrate })
      await started

      let pos = WAV_HEADER_BYTES
      try {
        while (pos < wavBlob.size) {
          const end = Math.min(wavBlob.size, pos + BLOCK_BYTES)
          const bytes = new Uint8Array(await wavBlob.slice(pos, end).arrayBuffer())
          const { l, r } = convert24to16(bytes)
          const next = wait()
          worker.postMessage({ type: 'chunk', l, r, done: end }, [l.buffer, r.buffer])
          await next
          pos = end
        }
        worker.postMessage({ type: 'end' })
      } catch (err) {
        worker.terminate()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })()
  })
}
