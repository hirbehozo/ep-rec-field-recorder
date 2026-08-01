import { describeEp136Message } from './ep136'

export type PortKind = 'ep136' | 'generic'

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function noteName(n: number): string {
  return NOTES[n % 12] + (Math.floor(n / 12) - 1)
}

export function describeMessage(data: ArrayLike<number>, portKind: PortKind = 'generic'): string {
  if (portKind === 'ep136') {
    const decoded = describeEp136Message(data)
    if (decoded) return decoded
  }

  const status = data[0] & 0xf0
  const channel = (data[0] & 0x0f) + 1
  if (status === 0x90 && data[2] > 0) return `${channel} ${noteName(data[1])} ${data[2]}`
  if (status === 0x80 || status === 0x90) return `${channel} ${noteName(data[1])} OFF`
  if (status === 0xb0) return `${channel} CC${data[1]} ${data[2]}`
  if (status === 0xc0) return `${channel} PRG ${data[1]}`
  if (status === 0xd0) return `${channel} AT ${data[1]}`
  if (status === 0xe0) return `${channel} BEND ${((data[2] << 7) | data[1]) - 8192}`
  if (data[0] === 0xfa) return 'START'
  if (data[0] === 0xfb) return 'CONT'
  if (data[0] === 0xfc) return 'STOP'
  return `SYS ${data[0].toString(16).toUpperCase()}`
}
