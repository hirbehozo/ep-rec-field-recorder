import { buildSMF } from './smf'
import type { MidiEvent } from './types'

interface ParsedEvent {
  tick: number
  status: number
  data1: number
  data2?: number
}

interface ParsedTrack {
  events: ParsedEvent[]
}

interface ParsedSMF {
  format: number
  trackCount: number
  ppq: number
  tracks: ParsedTrack[]
}

/** Minimal Standard MIDI File parser, just enough to check what buildSMF wrote. */
function parseSMF(bytes: Uint8Array): ParsedSMF {
  let pos = 0
  const readString = (n: number) => {
    let s = ''
    for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[pos++])
    return s
  }
  const readU32 = () => {
    const v = (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]
    pos += 4
    return v >>> 0
  }
  const readU16 = () => {
    const v = (bytes[pos] << 8) | bytes[pos + 1]
    pos += 2
    return v
  }
  const readVLQ = () => {
    let v = 0
    for (;;) {
      const b = bytes[pos++]
      v = (v << 7) | (b & 0x7f)
      if (!(b & 0x80)) break
    }
    return v
  }

  if (readString(4) !== 'MThd') throw new Error('missing MThd')
  const headerLen = readU32()
  if (headerLen !== 6) throw new Error(`MThd must be 6 data bytes, got ${headerLen}`)
  const format = readU16()
  const trackCount = readU16()
  const ppq = readU16()

  const tracks: ParsedTrack[] = []
  for (let t = 0; t < trackCount; t++) {
    if (readString(4) !== 'MTrk') throw new Error('missing MTrk')
    const len = readU32()
    const end = pos + len
    const events: ParsedEvent[] = []
    let tick = 0
    let running = 0
    while (pos < end) {
      tick += readVLQ()
      let status = bytes[pos]
      if (status & 0x80) {
        pos++
        running = status
      } else {
        status = running
      }
      if (status === 0xff) {
        const metaType = bytes[pos++]
        const metaLen = readVLQ()
        pos += metaLen
        if (metaType === 0x2f) continue // end of track
        continue
      }
      const data1 = bytes[pos++]
      const isTwoByte = (status & 0xf0) !== 0xc0 && (status & 0xf0) !== 0xd0
      const data2 = isTwoByte ? bytes[pos++] : undefined
      events.push({ tick, status, data1, data2 })
    }
    tracks.push({ events })
  }
  return { format, trackCount, ppq, tracks }
}

async function parseBlob(blob: Blob): Promise<ParsedSMF> {
  const buf = await blob.arrayBuffer()
  return parseSMF(new Uint8Array(buf))
}

describe('buildSMF', () => {
  it('places an event 250ms in at 120 BPM on tick 240', async () => {
    const events: MidiEvent[] = [{ t: 250, p: 'test', d: [0x90, 60, 100] }]
    const parsed = await parseBlob(buildSMF(events, 120, 0))
    const noteOn = parsed.tracks[1].events.find((e) => (e.status & 0xf0) === 0x90)
    expect(noteOn).toBeDefined()
    expect(noteOn?.tick).toBe(240)
  })

  it('closes hanging notes with an explicit note-off at the end', async () => {
    const events: MidiEvent[] = [{ t: 0, p: 'test', d: [0x90, 64, 90] }]
    const parsed = await parseBlob(buildSMF(events, 120, 0))
    const noteEvents = parsed.tracks[1].events.filter((e) => e.data1 === 64)
    expect(noteEvents).toHaveLength(2)
    expect((noteEvents[0].status & 0xf0) === 0x90 && (noteEvents[0].data2 ?? 0) > 0).toBe(true)
    const closer = noteEvents[1]
    const isNoteOff =
      (closer.status & 0xf0) === 0x80 || ((closer.status & 0xf0) === 0x90 && closer.data2 === 0)
    expect(isNoteOff).toBe(true)
  })

  it('rewrites a zero-velocity note-on as a note-off', async () => {
    const events: MidiEvent[] = [
      { t: 0, p: 'test', d: [0x90, 67, 100] },
      { t: 100, p: 'test', d: [0x90, 67, 0] },
    ]
    const parsed = await parseBlob(buildSMF(events, 120, 0))
    const noteEvents = parsed.tracks[1].events.filter((e) => e.data1 === 67)
    expect(noteEvents).toHaveLength(2)
    expect(noteEvents[1].status & 0xf0).toBe(0x80)
  })

  it('has an MThd chunk with 6 data bytes and a track count matching the ports plus tempo track', async () => {
    const events: MidiEvent[] = [
      { t: 0, p: 'port a', d: [0x90, 60, 100] },
      { t: 10, p: 'port b', d: [0x90, 61, 100] },
    ]
    const parsed = await parseBlob(buildSMF(events, 120, 0))
    expect(parsed.trackCount).toBe(3) // tempo + 2 ports
    expect(parsed.tracks).toHaveLength(3)
    expect(parsed.ppq).toBe(480)
    expect(parsed.format).toBe(1)
  })

  it('shifts events by the offset before quantizing to ticks', async () => {
    const events: MidiEvent[] = [{ t: 250, p: 'test', d: [0x90, 60, 100] }]
    const parsedPositive = await parseBlob(buildSMF(events, 120, 100))
    const parsedNegative = await parseBlob(buildSMF(events, 120, -100))
    const tickAt = (parsed: ParsedSMF) =>
      parsed.tracks[1].events.find((e) => (e.status & 0xf0) === 0x90)?.tick
    expect(tickAt(parsedPositive)).toBe(336) // (250+100)ms -> 336 ticks at 120bpm/480ppq
    expect(tickAt(parsedNegative)).toBe(144) // (250-100)ms -> 144 ticks
  })

  it('drops non-channel bytes like MIDI clock from the output', async () => {
    const events: MidiEvent[] = [
      { t: 0, p: 'test', d: [0xf8] },
      { t: 10, p: 'test', d: [0x90, 60, 100] },
    ]
    const parsed = await parseBlob(buildSMF(events, 120, 0))
    expect(parsed.tracks[1].events).toHaveLength(2) // note on + closing note off
  })
})
