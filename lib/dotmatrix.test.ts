import { DM_COLS, DM_ROWS, DotMatrix } from './dotmatrix'

function rightmostLitColumn(dm: DotMatrix, yStart: number, yEnd: number): number {
  let max = -1
  for (let y = yStart; y < yEnd; y++) {
    for (let x = 0; x < DM_COLS; x++) {
      if (dm.buf[y * DM_COLS + x] !== 0) max = Math.max(max, x)
    }
  }
  return max
}

describe('DotMatrix width / advance', () => {
  const strings = ['A', 'AB', 'HELLO', '00:00:00', 'BPM120.5', '']
  const scales = [1, 2]

  it('text() advances by exactly width(str, s) + s pixels', () => {
    for (const s of scales) {
      for (const str of strings) {
        const dm = new DotMatrix()
        const startX = 3
        const endX = dm.text(str, startX, 0, s, 1)
        const advance = endX - startX
        expect(advance).toBe(dm.width(str, s) + s)
      }
    }
  })

  it('right-aligned text never overflows the 96 column grid', () => {
    for (const s of scales) {
      for (const str of strings) {
        if (!str) continue
        const dm = new DotMatrix()
        dm.right(str, DM_COLS, 0, s, 1)
        const maxX = rightmostLitColumn(dm, 0, 7 * s)
        expect(maxX).toBeLessThan(DM_COLS)
        expect(maxX).toBe(DM_COLS - 1)
      }
    }
  })

  it('right-aligned text at an interior x still lands its last pixel one before xEnd', () => {
    const dm = new DotMatrix()
    const xEnd = 50
    dm.right('OK', xEnd, 0, 1, 1)
    const maxX = rightmostLitColumn(dm, 0, 7)
    expect(maxX).toBe(xEnd - 1)
  })
})

describe('DotMatrix buffer primitives', () => {
  it('plot ignores out-of-bounds coordinates', () => {
    const dm = new DotMatrix()
    dm.plot(-1, 0, 1)
    dm.plot(0, -1, 1)
    dm.plot(DM_COLS, 0, 1)
    dm.plot(0, DM_ROWS, 1)
    expect(dm.buf.every((v) => v === 0)).toBe(true)
  })

  it('clear resets all dots to 0 and fill sets all dots to 1', () => {
    const dm = new DotMatrix()
    dm.plot(5, 5, 2)
    dm.fill()
    expect(dm.buf.every((v) => v === 1)).toBe(true)
    dm.clear()
    expect(dm.buf.every((v) => v === 0)).toBe(true)
  })

  it('bar lights a fraction of the range plus a permanent end-of-scale tick', () => {
    const dm = new DotMatrix()
    dm.bar(8, 95, 0, 1, 0.5, 0.86)
    const litCount = Array.from(dm.buf.slice(0, DM_COLS)).filter((v) => v !== 0).length
    // half of the 87-wide range, plus the tick at x1=95
    expect(litCount).toBe(Math.round(0.5 * (95 - 8)) + 1)
    expect(dm.buf[95]).toBe(1) // end-of-scale tick
  })
})
