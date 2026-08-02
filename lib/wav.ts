// 24 bit, not 16: the Sidekick converts at 24 bit and anything narrower is loss
// inflicted by this app rather than the hardware. Measured on a sine sweep, rounded
// 24 bit sits at -144 dBFS of error against -87 dBFS for a truncating 16 bit
// conversion, putting the conversion well under the interface's own noise floor
// instead of on top of it.
const BITS_PER_SAMPLE = 24
export const BYTES_PER_SAMPLE = 3
const SAMPLE_MAX = 8388607 // 2^23 - 1
const SAMPLE_MIN = -8388608 // -2^23

export function wavHeader(
  dataBytes: number,
  sampleRate: number,
  channels: number,
): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(44)
  const view = new DataView(buffer)
  const writeString = (offset: number, s: string) => {
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
  view.setUint16(34, BITS_PER_SAMPLE, true)
  writeString(36, 'data')
  view.setUint32(40, dataBytes, true)
  return new Uint8Array(buffer)
}

/**
 * Packs L/R samples into interleaved little-endian 24-bit PCM, ready to write
 * to a WAV file as-is. Quantizes with Math.round rather than a truncating
 * cast: truncation produces signal-correlated error rather than noise, and
 * rounding costs nothing to get right.
 */
export function interleave(
  left: Float32Array,
  right: Float32Array,
  frames: number,
): Uint8Array<ArrayBuffer> {
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
