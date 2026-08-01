import { accumulateEp136Gain, describeEp136Message, looksLikeEp136 } from './ep136'

describe('looksLikeEp136', () => {
  it('matches Sidekick and EP-136 port names', () => {
    expect(looksLikeEp136('K.O. Sidekick')).toBe(true)
    expect(looksLikeEp136('EP-136')).toBe(true)
    expect(looksLikeEp136('ep136')).toBe(true)
    expect(looksLikeEp136('sidekick')).toBe(true)
  })

  it('does not match unrelated port names', () => {
    expect(looksLikeEp136('EP-133 K.O. II')).toBe(false)
    expect(looksLikeEp136('USB MIDI Device')).toBe(false)
  })
})

describe('describeEp136Message', () => {
  const cases: Array<[string, number[], string]> = [
    ['channel 1 fader', [0xb0, 7, 98], 'CH1 FADER 98'],
    ['channel 2 fader', [0xb1, 7, 50], 'CH2 FADER 50'],
    ['aux fader', [0xb2, 7, 10], 'AUX FADER 10'],
    ['cue on', [0xb0, 3, 127], 'CH1 CUE ON'],
    ['cue off', [0xb0, 3, 0], 'CH1 CUE OFF'],
    ['fx button on', [0xb0, 14, 100], 'CH1 FX ON'],
    ['fx button off', [0xb0, 14, 20], 'CH1 FX OFF'],
    ['fx pad pressure', [0xb0, 1, 64], 'CH1 FX PAD 64'],
    ['gain encoder positive', [0xb1, 20, 3], 'CH2 GAIN +3'],
    ['gain encoder no change at 0', [0xb1, 20, 0], 'CH2 GAIN 0'],
    // value 64 does not hit the < 64 branch, so it decodes as -64, not "no
    // change" — the formula's actual behavior, even though it reads oddly
    // against the "0 and 64 mean no change" prose in the source material.
    ['gain encoder value 64 decodes as -64 per the formula', [0xb1, 20, 64], 'CH2 GAIN -64'],
    ['gain encoder negative', [0xb1, 20, 127], 'CH2 GAIN -1'],
    ['eq high above flat', [0xb2, 22, 76], 'AUX EQ HI +12'],
    ['eq high at flat', [0xb2, 22, 64], 'AUX EQ HI 0'],
    ['eq mid below flat', [0xb0, 23, 52], 'CH1 EQ MID -12'],
    ['eq low below flat', [0xb0, 24, 40], 'CH1 EQ LO -24'],
    ['mod lever centered', [0xe0, 0, 64], 'CH1 MOD 0'],
    ['mod lever positive', [0xe1, 127, 127], 'CH2 MOD +8191'],
    ['mod lever negative', [0xe0, 0, 0], 'CH1 MOD -8192'],
    ['unmapped channel falls back to CHn', [0xb4, 7, 10], 'CH5 FADER 10'],
  ]

  it.each(cases)('%s', (_label, data, expected) => {
    expect(describeEp136Message(data)).toBe(expected)
  })

  it('returns null for CC numbers not in the Sidekick table', () => {
    expect(describeEp136Message([0xb0, 99, 10])).toBeNull()
  })

  it('returns null for message types the Sidekick table does not cover', () => {
    expect(describeEp136Message([0x90, 60, 100])).toBeNull()
    expect(describeEp136Message([0xc0, 5])).toBeNull()
  })
})

describe('accumulateEp136Gain', () => {
  it('accumulates positive increments', () => {
    expect(accumulateEp136Gain(64, 1)).toBe(65)
    expect(accumulateEp136Gain(64, 63)).toBe(127)
  })

  it('accumulates negative increments (values 65-127 decode as value - 128)', () => {
    expect(accumulateEp136Gain(64, 127)).toBe(63) // 127 - 128 = -1
    expect(accumulateEp136Gain(64, 65)).toBe(1) // 65 - 128 = -63
  })

  it('treats 0 as no change; 64 decodes as -64 per the formula, not as no change', () => {
    expect(accumulateEp136Gain(64, 0)).toBe(64)
    expect(accumulateEp136Gain(64, 64)).toBe(0)
  })

  it('clamps to the 0-127 range and does not wrap', () => {
    expect(accumulateEp136Gain(126, 63)).toBe(127) // would overshoot to 189
    expect(accumulateEp136Gain(1, 65)).toBe(0) // delta -63 would undershoot to -62
  })

  it('wraps correctly across zero over a sequence of deltas', () => {
    let gain = 2
    gain = accumulateEp136Gain(gain, 127) // -1 -> clamps at 1
    expect(gain).toBe(1)
    gain = accumulateEp136Gain(gain, 65) // -63 -> clamps at 0
    expect(gain).toBe(0)
    gain = accumulateEp136Gain(gain, 5) // +5 -> 5
    expect(gain).toBe(5)
  })
})
