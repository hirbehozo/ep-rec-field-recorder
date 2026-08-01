import { describeMessage } from './describeMessage'

describe('describeMessage', () => {
  const cases: Array<[string, number[], string]> = [
    ['note on', [0x90, 60, 100], '1 C4 100'],
    ['note on with zero velocity is a note off', [0x90, 60, 0], '1 C4 OFF'],
    ['explicit note off', [0x80, 60, 0], '1 C4 OFF'],
    ['note name at the low end of the range', [0x90, 0, 100], '1 C-1 100'],
    ['note name at the high end of the range', [0x90, 127, 100], '1 G9 100'],
    ['channel 16 (nibble 0xF)', [0x9f, 60, 100], '16 C4 100'],
    ['control change', [0xb0, 7, 127], '1 CC7 127'],
    ['program change', [0xc0, 5], '1 PRG 5'],
    ['channel aftertouch', [0xd0, 64], '1 AT 64'],
    ['pitch bend centered', [0xe0, 0, 64], '1 BEND 0'],
    ['pitch bend at maximum', [0xe0, 127, 127], '1 BEND 8191'],
    ['pitch bend at minimum', [0xe0, 0, 0], '1 BEND -8192'],
    ['transport start', [0xfa], 'START'],
    ['transport continue', [0xfb], 'CONT'],
    ['transport stop', [0xfc], 'STOP'],
    ['unrecognized system message falls back to hex', [0xf0], 'SYS F0'],
  ]

  it.each(cases)('%s', (_label, data, expected) => {
    expect(describeMessage(data)).toBe(expected)
  })

  it('accepts a Uint8Array the same as a plain array', () => {
    expect(describeMessage(new Uint8Array([0x90, 60, 100]))).toBe('1 C4 100')
  })

  it('defaults to generic decoding when no portKind is given', () => {
    expect(describeMessage([0xb0, 7, 98])).toBe('1 CC7 98')
  })

  it('uses EP-136 decoding for ep136 ports when the CC is in its table', () => {
    expect(describeMessage([0xb0, 7, 98], 'ep136')).toBe('CH1 FADER 98')
  })

  it('falls back to generic decoding for ep136 ports on CCs outside the table', () => {
    expect(describeMessage([0xb0, 99, 10], 'ep136')).toBe('1 CC99 10')
  })

  it('falls back to generic decoding for ep136 ports on note messages', () => {
    expect(describeMessage([0x90, 60, 100], 'ep136')).toBe('1 C4 100')
  })
})
