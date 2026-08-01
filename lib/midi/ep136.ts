// Decodes the K.O. Sidekick (EP-136)'s mixer control stream into readable
// names. Community derived by monitoring a real unit, not vendor
// documented, so this is a strong hypothesis rather than ground truth —
// keep the raw bytes in every take regardless of how they decode here.
// See reference/hardware.md for the source table.

const EP136_CC: Record<number, string> = {
  1: 'FX PAD',
  3: 'CUE',
  7: 'FADER',
  14: 'FX',
  20: 'GAIN',
  22: 'EQ HI',
  23: 'EQ MID',
  24: 'EQ LO',
}

const EP136_CH: Record<number, string> = { 1: 'CH1', 2: 'CH2', 3: 'AUX' }

const signed = (n: number): string => (n > 0 ? `+${n}` : `${n}`)

export function looksLikeEp136(portName: string): boolean {
  return /sidekick|ep-?136/i.test(portName)
}

/**
 * Per-message live ticker text for a Sidekick control change, e.g.
 * "CH1 FADER 98" or "CH2 GAIN +3". Returns null for anything this table
 * doesn't cover, so the caller can fall back to the generic decoder.
 */
export function describeEp136Message(data: ArrayLike<number>): string | null {
  const status = data[0] & 0xf0
  const channel = (data[0] & 0x0f) + 1
  const strip = EP136_CH[channel] ?? `CH${channel}`

  if (status === 0xe0) return `${strip} MOD ${signed(((data[2] << 7) | data[1]) - 8192)}`
  if (status !== 0xb0) return null

  const name = EP136_CC[data[1]]
  if (!name) return null

  if (data[1] === 3 || data[1] === 14) return `${strip} ${name} ${data[2] > 63 ? 'ON' : 'OFF'}`
  // relative encoder: we only ever see change, never absolute position
  if (data[1] === 20) return `${strip} GAIN ${signed(data[2] < 64 ? data[2] : data[2] - 128)}`
  if (data[1] >= 22 && data[1] <= 24) return `${strip} ${name} ${signed(data[2] - 64)}`
  return `${strip} ${name} ${data[2]}`
}

/**
 * CC20 (gain encoder) is relative: 1-63 are positive increments, 0 and 64
 * mean no change, 65-127 decode as value - 128. The encoder never reports
 * where the knob physically is, so any accumulated total is a delta from
 * an unknown starting point, never a true absolute reading — do not
 * present the result as an absolute gain value in the UI.
 */
export function accumulateEp136Gain(current: number, ccValue: number): number {
  const delta = ccValue < 64 ? ccValue : ccValue - 128
  return Math.max(0, Math.min(127, current + delta))
}
