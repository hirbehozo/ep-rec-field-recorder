import { interleave, wavHeader } from './wav'

function readString(view: DataView, offset: number, length: number): string {
  let s = ''
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i))
  return s
}

/** Decodes one packed little-endian 24-bit two's-complement sample back to [-1, 1]. */
function decode24(bytes: Uint8Array, offset: number): number {
  let q = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
  if (q & 0x800000) q -= 0x1000000
  return q / 8388608
}

describe('wavHeader', () => {
  it('writes RIFF/WAVE/fmt /data chunk ids at the correct offsets', () => {
    const header = wavHeader(1000, 48000, 2)
    const view = new DataView(header.buffer)
    expect(header.length).toBe(44)
    expect(readString(view, 0, 4)).toBe('RIFF')
    expect(readString(view, 8, 4)).toBe('WAVE')
    expect(readString(view, 12, 4)).toBe('fmt ')
    expect(readString(view, 36, 4)).toBe('data')
  })

  it('writes little-endian numeric fields at the correct offsets for 24-bit PCM', () => {
    const dataBytes = 3000
    const sampleRate = 44100
    const channels = 2
    const header = wavHeader(dataBytes, sampleRate, channels)
    const view = new DataView(header.buffer)
    const blockAlign = channels * 3
    expect(view.getUint32(4, true)).toBe(36 + dataBytes)
    expect(view.getUint32(16, true)).toBe(16) // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(channels)
    expect(view.getUint32(24, true)).toBe(sampleRate)
    expect(view.getUint32(28, true)).toBe(sampleRate * blockAlign) // byte rate
    expect(view.getUint16(32, true)).toBe(blockAlign) // block align
    expect(view.getUint16(34, true)).toBe(24) // bits per sample
    expect(view.getUint32(40, true)).toBe(dataBytes)
  })

  it('computes blockAlign/byteRate correctly for mono too', () => {
    const header = wavHeader(0, 48000, 1)
    const view = new DataView(header.buffer)
    expect(view.getUint16(32, true)).toBe(3) // 1 channel * 3 bytes
    expect(view.getUint32(28, true)).toBe(48000 * 3)
  })
})

describe('interleave', () => {
  it('interleaves L/R samples in order', () => {
    const l = new Float32Array([0.5, -0.5])
    const r = new Float32Array([0.25, -0.25])
    const out = interleave(l, r, 2)
    expect(out.length).toBe(2 * 2 * 3)
    expect(decode24(out, 0)).toBeCloseTo(0.5, 6)
    expect(decode24(out, 3)).toBeCloseTo(0.25, 6)
    expect(decode24(out, 6)).toBeCloseTo(-0.5, 6)
    expect(decode24(out, 9)).toBeCloseTo(-0.25, 6)
  })

  it('rounds rather than truncates', () => {
    // 0.1 * 8388608 = 838860.8 -> rounds to 838861, a truncating cast would give 838860
    const out = interleave(new Float32Array([0.1]), new Float32Array([0]), 1)
    const q = out[0] | (out[1] << 8) | (out[2] << 16)
    expect(q).toBe(838861)
  })

  it('clamps beyond +/-1 to the 24-bit rails without wrapping to the opposite sign', () => {
    const l = new Float32Array([1.5, -1.5])
    const r = new Float32Array([-2.5, 3.5])
    const out = interleave(l, r, 2)
    expect(decode24(out, 0)).toBeCloseTo(1, 6) // clamped to +max
    expect(decode24(out, 3)).toBeCloseTo(-1, 6) // clamped to -max
    expect(decode24(out, 6)).toBeCloseTo(-1, 6)
    expect(decode24(out, 9)).toBeCloseTo(1, 6)
    for (let i = 0; i < out.length; i += 3) {
      const v = decode24(out, i)
      expect(v).toBeLessThanOrEqual(1)
      expect(v).toBeGreaterThanOrEqual(-1)
    }
  })

  it('round-trips a full-scale sine with error below -140 dBFS', () => {
    const frames = 4096
    const l = new Float32Array(frames)
    const r = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      const v = 0.999 * Math.sin((2 * Math.PI * 440 * i) / 48000)
      l[i] = v
      r[i] = v
    }
    const out = interleave(l, r, frames)

    let sumSquaredError = 0
    for (let i = 0; i < frames; i++) {
      const decoded = decode24(out, i * 6)
      const error = decoded - l[i]
      sumSquaredError += error * error
    }
    const rmsError = Math.sqrt(sumSquaredError / frames)
    const errorDbfs = 20 * Math.log10(rmsError)
    expect(errorDbfs).toBeLessThan(-140)
  })
})
