import { bpmFromClocks } from './tempo'

function clockTrainAt(bpm: number, count: number, startMs = 0): number[] {
  const intervalMs = 60000 / bpm / 24
  return Array.from({ length: count }, (_, i) => startMs + i * intervalMs)
}

describe('bpmFromClocks', () => {
  it('returns null on insufficient samples', () => {
    expect(bpmFromClocks(clockTrainAt(120, 24))).toBeNull()
    expect(bpmFromClocks([])).toBeNull()
    expect(bpmFromClocks([0])).toBeNull()
  })

  it('returns null on nonsense input', () => {
    expect(bpmFromClocks(new Array(30).fill(0))).toBeNull() // zero span
    expect(bpmFromClocks(clockTrainAt(5, 30))).toBeNull() // below 20 bpm floor
    expect(bpmFromClocks(clockTrainAt(500, 30))).toBeNull() // above 400 bpm ceiling
  })

  it('derives bpm from a steady 24-clocks-per-quarter train', () => {
    const bpm = bpmFromClocks(clockTrainAt(120, 25))
    expect(bpm).not.toBeNull()
    expect(bpm as number).toBeCloseTo(120, 5)
  })

  it('works on a longer window spanning a whole take', () => {
    const bpm = bpmFromClocks(clockTrainAt(93.6, 400))
    expect(bpm).not.toBeNull()
    expect(bpm as number).toBeCloseTo(93.6, 5)
  })
})
