import { convert24to16 } from './mp3'

/** Packs one 24-bit stereo frame the same way lib/wav.ts's interleave() does. */
function pack24(l: number, r: number): number[] {
  const enc = (v: number) => {
    let q = v
    if (q < 0) q += 1 << 24
    return [q & 255, (q >> 8) & 255, (q >> 16) & 255]
  }
  return [...enc(l), ...enc(r)]
}

describe('convert24to16', () => {
  it('converts a simple in-range frame', () => {
    // 0x400000 (4194304) at 24-bit -> (4194304 + 128) >> 8 = 16384
    const bytes = new Uint8Array(pack24(0x400000, -0x400000))
    const { l, r } = convert24to16(bytes)
    expect(l.length).toBe(1)
    expect(r.length).toBe(1)
    expect(l[0]).toBe(16384)
    expect(r[0]).toBe(-16384)
  })

  it('rounds rather than truncates via the +128 pre-shift bias', () => {
    // 200 in 24-bit: (200 + 128) >> 8 = 328 >> 8 = 1 (rounds up from 0.78)
    const bytes = new Uint8Array(pack24(200, 0))
    const { l } = convert24to16(bytes)
    expect(l[0]).toBe(1)
  })

  it('clamps a near-full-scale sample that rounds one past the 16-bit ceiling', () => {
    // max 24-bit value 8388607: (8388607 + 128) >> 8 = 32768, clamped to 32767
    const bytes = new Uint8Array(pack24(8388607, -8388608))
    const { l, r } = convert24to16(bytes)
    expect(l[0]).toBe(32767)
    expect(r[0]).toBe(-32768)
  })

  it('processes multiple frames in order', () => {
    const bytes = new Uint8Array([...pack24(1000, -1000), ...pack24(2000, -2000)])
    const { l, r } = convert24to16(bytes)
    expect(l.length).toBe(2)
    expect(l[0]).toBe((1000 + 128) >> 8)
    expect(r[0]).toBe((-1000 + 128) >> 8)
    expect(l[1]).toBe((2000 + 128) >> 8)
    expect(r[1]).toBe((-2000 + 128) >> 8)
  })

  it('drops a trailing partial frame rather than reading out of bounds', () => {
    const bytes = new Uint8Array([...pack24(1000, -1000), 1, 2, 3]) // 9 bytes, 1.5 frames
    const { l, r } = convert24to16(bytes)
    expect(l.length).toBe(1)
    expect(r.length).toBe(1)
  })
})
