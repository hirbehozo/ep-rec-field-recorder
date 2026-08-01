import type { MidiEvent } from './types'

const PPQ = 480

function vlq(nIn: number): number[] {
  let n = nIn
  const out = [n & 0x7f]
  n >>= 7
  while (n > 0) {
    out.unshift((n & 0x7f) | 0x80)
    n >>= 7
  }
  return out
}

function chunk(id: string, bytes: number[]): number[] {
  const h: number[] = []
  for (const c of id) h.push(c.charCodeAt(0))
  const len = bytes.length
  h.push((len >> 24) & 255, (len >> 16) & 255, (len >> 8) & 255, len & 255)
  return h.concat(bytes)
}

export function buildSMF(events: MidiEvent[], bpm: number, offsetMs: number): Blob {
  const tempo = bpm && isFinite(bpm) ? bpm : 120
  const toTick = (ms: number) => Math.max(0, Math.round(((ms + offsetMs) * PPQ * tempo) / 60000))
  const usable = events.filter((e) => e.d[0] >= 0x80 && e.d[0] <= 0xef)
  const ports = [...new Set(usable.map((e) => e.p))]
  const tracks: number[][] = []
  const mpqn = Math.round(60000000 / tempo)

  const tempoTrack: number[] = [
    ...vlq(0),
    0xff,
    0x51,
    0x03,
    (mpqn >> 16) & 255,
    (mpqn >> 8) & 255,
    mpqn & 255,
    ...vlq(0),
    0xff,
    0x58,
    0x04,
    4,
    2,
    24,
    8,
    ...vlq(0),
    0xff,
    0x2f,
    0x00,
  ]
  tracks.push(chunk('MTrk', tempoTrack))

  for (const p of ports) {
    const evs = usable.filter((e) => e.p === p).sort((a, b) => a.t - b.t)
    const name = p.slice(0, 60)
    let bytes: number[] = [
      ...vlq(0),
      0xff,
      0x03,
      name.length,
      ...[...name].map((c) => c.charCodeAt(0) & 0x7f),
    ]
    let last = 0
    const active = new Set<string>()
    for (const e of evs) {
      const tick = toTick(e.t)
      const d = e.d.slice()
      let st = d[0]
      if ((st & 0xf0) === 0x90 && d[2] === 0) {
        d[0] = 0x80 | (st & 0x0f)
        st = d[0]
      }
      bytes = [...bytes, ...vlq(Math.max(0, tick - last)), ...d]
      last = Math.max(last, tick)
      const key = `${st & 0x0f}:${d[1]}`
      if ((st & 0xf0) === 0x90) active.add(key)
      if ((st & 0xf0) === 0x80) active.delete(key)
    }
    for (const key of active) {
      const [ch, n] = key.split(':').map(Number)
      bytes = [...bytes, ...vlq(0), 0x80 | ch, n, 0]
    }
    bytes = [...bytes, ...vlq(0), 0xff, 0x2f, 0x00]
    tracks.push(chunk('MTrk', bytes))
  }

  const nt = tracks.length
  const head = chunk('MThd', [0, 1, (nt >> 8) & 255, nt & 255, (PPQ >> 8) & 255, PPQ & 255])
  const all = new Uint8Array(head.length + tracks.reduce((a, b) => a + b.length, 0))
  let offset = 0
  all.set(head, offset)
  offset += head.length
  for (const tr of tracks) {
    all.set(tr, offset)
    offset += tr.length
  }
  return new Blob([all], { type: 'audio/midi' })
}
