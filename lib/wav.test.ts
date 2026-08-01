import { interleave, wavHeader } from './wav'

function readString(view: DataView, offset: number, length: number): string {
  let s = ''
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i))
  return s
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

  it('writes little-endian numeric fields at the correct offsets', () => {
    const dataBytes = 2000
    const sampleRate = 44100
    const channels = 2
    const header = wavHeader(dataBytes, sampleRate, channels)
    const view = new DataView(header.buffer)
    expect(view.getUint32(4, true)).toBe(36 + dataBytes)
    expect(view.getUint32(16, true)).toBe(16) // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(channels)
    expect(view.getUint32(24, true)).toBe(sampleRate)
    expect(view.getUint32(28, true)).toBe(sampleRate * channels * 2) // byte rate
    expect(view.getUint16(32, true)).toBe(channels * 2) // block align
    expect(view.getUint16(34, true)).toBe(16) // bits per sample
    expect(view.getUint32(40, true)).toBe(dataBytes)
  })
})

describe('interleave', () => {
  it('interleaves L/R samples in order', () => {
    const l = new Float32Array([0.1, 0.2, 0.3])
    const r = new Float32Array([-0.1, -0.2, -0.3])
    const out = interleave(l, r, 3)
    expect(out.length).toBe(6)
    // Int16Array assignment truncates toward zero, it does not round.
    expect(out[0]).toBe(Math.trunc(0.1 * 0x7fff))
    expect(out[1]).toBe(Math.trunc(-0.1 * 0x8000))
    expect(out[2]).toBe(Math.trunc(0.2 * 0x7fff))
    expect(out[3]).toBe(Math.trunc(-0.2 * 0x8000))
  })

  it('clamps beyond +/-1 without wrapping', () => {
    const l = new Float32Array([1.5, -1.5])
    const r = new Float32Array([-2.5, 3.5])
    const out = interleave(l, r, 2)
    // clamped to +1 -> 0x7FFF, -1 -> -0x8000, never overflowing into the opposite sign
    expect(out[0]).toBe(0x7fff)
    expect(out[1]).toBe(-0x8000)
    expect(out[2]).toBe(-0x8000)
    expect(out[3]).toBe(0x7fff)
    for (const v of out) {
      expect(v).toBeLessThanOrEqual(0x7fff)
      expect(v).toBeGreaterThanOrEqual(-0x8000)
    }
  })
})
