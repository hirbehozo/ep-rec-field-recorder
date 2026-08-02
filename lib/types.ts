export interface MidiEvent {
  t: number
  p: string
  d: number[]
}

export interface SessionMeta {
  id: string
  n: number
  startedAt: string
  duration: number
  sampleRate: number
  channels: number
  device: string
  bpm: number | null
  clipped: boolean
  offsetMs: number
  events: number
  ports: string[]
  wav: string
  midi: string
  mem: boolean
  writeErrors: number
  missingFrames: number
}

export interface SessionPayload {
  meta: SessionMeta
  events: MidiEvent[]
  clocks: number[]
}
