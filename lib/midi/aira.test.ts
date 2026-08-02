import { looksLikeAira } from './aira'

describe('looksLikeAira', () => {
  it('matches Roland Aira Compact port names', () => {
    expect(looksLikeAira('Roland S-1')).toBe(true)
    expect(looksLikeAira('AIRA Compact J-6')).toBe(true)
    expect(looksLikeAira('T-8')).toBe(true)
    expect(looksLikeAira('E-4')).toBe(true)
    expect(looksLikeAira('P-6')).toBe(true)
    expect(looksLikeAira('s-1')).toBe(true)
  })

  it('does not match unrelated port names', () => {
    expect(looksLikeAira('K.O. Sidekick')).toBe(false)
    expect(looksLikeAira('USB MIDI Device')).toBe(false)
  })

  it('does not mistake the K.O. II for an Aira: "EP-133" contains "P-1" as a substring', () => {
    expect(looksLikeAira('EP-133 K.O. II')).toBe(false)
    expect(looksLikeAira('EP-133')).toBe(false)
  })
})
