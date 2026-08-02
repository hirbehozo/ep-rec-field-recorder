// Runs off the main thread so a slow render can never stall a disk write:
// PCM conversion (24-bit interleave) and the actual OPFS write both happen
// here, via createSyncAccessHandle, which is worker-only. A real file
// rather than bundled via the app's TS build, same reasoning as
// rec-worklet.js: Next's bundler does not reliably turn
// `new Worker(new URL(...))` into a real worker chunk, so this has to be a
// plain static file loaded by URL. The 24-bit WAV logic here must be kept
// in sync with lib/wav.ts and lib/audio/writeSession.ts, which are the
// tested reference implementation of the same algorithm.

const BYTES_PER_SAMPLE = 3
const SAMPLE_MAX = 8388607 // 2^23 - 1
const SAMPLE_MIN = -8388608 // -2^23

function wavHeader(dataBytes, sampleRate, channels) {
  const buffer = new ArrayBuffer(44)
  const view = new DataView(buffer)
  const writeString = (offset, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  const blockAlign = channels * BYTES_PER_SAMPLE
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 24, true)
  writeString(36, 'data')
  view.setUint32(40, dataBytes, true)
  return new Uint8Array(buffer)
}

function interleave(left, right, frames) {
  const out = new Uint8Array(frames * 2 * BYTES_PER_SAMPLE)
  let j = 0
  for (let i = 0; i < frames; i++) {
    for (const src of [left, right]) {
      let v = src[i]
      v = v > 1 ? 1 : v < -1 ? -1 : v
      let q = Math.round(v * (SAMPLE_MAX + 1))
      if (q > SAMPLE_MAX) q = SAMPLE_MAX
      if (q < SAMPLE_MIN) q = SAMPLE_MIN
      if (q < 0) q += 1 << 24
      out[j++] = q & 255
      out[j++] = (q >> 8) & 255
      out[j++] = (q >> 16) & 255
    }
  }
  return out
}

class WriteSession {
  constructor(handle, sampleRate, channels) {
    this.handle = handle
    this.sampleRate = sampleRate
    this.channels = channels
    this.position = 44
    this.frames = 0
    this.writeErrors = 0
    this.tryWrite(wavHeader(0, sampleRate, channels), 0)
  }

  tryWrite(bytes, position) {
    try {
      this.handle.write(bytes, { at: position })
      return true
    } catch (e) {
      this.writeErrors++
      return false
    }
  }

  writeChunk(l, r, frames) {
    const bytes = interleave(l, r, frames)
    if (this.tryWrite(bytes, this.position)) {
      this.position += bytes.byteLength
      this.frames += frames
    }
  }

  finish() {
    const dataBytes = this.frames * this.channels * BYTES_PER_SAMPLE
    this.tryWrite(wavHeader(dataBytes, this.sampleRate, this.channels), 0)
    try {
      this.handle.flush()
    } catch (e) {}
    this.handle.close()
    return { frames: this.frames, writeErrors: this.writeErrors }
  }
}

let session = null

self.onmessage = async (e) => {
  const msg = e.data

  if (msg.type === 'open') {
    try {
      const accessHandle = await msg.fileHandle.createSyncAccessHandle()
      session = new WriteSession(accessHandle, msg.sampleRate, msg.channels)
      self.postMessage({ type: 'opened' })
    } catch (err) {
      self.postMessage({ type: 'openError', message: (err && err.message) || String(err) })
    }
    return
  }

  if (msg.type === 'pcm') {
    if (session) session.writeChunk(msg.l, msg.r, msg.frames)
    return
  }

  if (msg.type === 'close') {
    const result = session ? session.finish() : { frames: 0, writeErrors: 0 }
    session = null
    self.postMessage({ type: 'closed', frames: result.frames, writeErrors: result.writeErrors })
  }
}
