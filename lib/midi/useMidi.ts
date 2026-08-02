import { useCallback, useRef, useState } from 'react'
import { bpmFromClocks } from '../tempo'
import type { MidiEvent } from '../types'
import { looksLikeAira } from './aira'
import { describeMessage, type PortKind } from './describeMessage'
import { looksLikeEp136 } from './ep136'

export { describeMessage }

export interface MidiPortInfo {
  id: string
  name: string
  manufacturer: string
  state: MIDIPortDeviceState
  armed: boolean
  kind: PortKind
}

export interface MidiState {
  supported: boolean
  granted: boolean
  error: string | null
  ports: MidiPortInfo[]
  liveBpm: number | null
  midiSeen: boolean
  lastEventText: string
  recordedEventCount: number
}

export interface MidiTakeResult {
  events: MidiEvent[]
  clocks: number[]
}

// Rolling window for the live BPM readout, mirroring the prototype: keep a
// buffer a bit larger than the minimum, but always compute from just the
// most recent 25 clocks so the display stays responsive to tempo changes.
const LIVE_CLOCK_WINDOW = 73
const LIVE_BPM_SAMPLES = 25

interface RecordingBuffer {
  t0: number
  events: MidiEvent[]
  clocks: number[]
}

function initialState(): MidiState {
  return {
    supported: typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator,
    granted: false,
    error: null,
    ports: [],
    liveBpm: null,
    midiSeen: false,
    lastEventText: '',
    recordedEventCount: 0,
  }
}

export type NoteOnHandler = (channel: number, note: number, portKind: PortKind) => void

export function useMidi() {
  const [state, setState] = useState<MidiState>(initialState)
  const accessRef = useRef<MIDIAccess | null>(null)
  const armedRef = useRef<Map<string, boolean>>(new Map())
  const kindRef = useRef<Map<string, PortKind>>(new Map())
  const liveClocksRef = useRef<number[]>([])
  const recordingRef = useRef<RecordingBuffer | null>(null)
  const noteHandlerRef = useRef<NoteOnHandler | null>(null)

  const setNoteHandler = useCallback((handler: NoteOnHandler | null) => {
    noteHandlerRef.current = handler
  }, [])

  const handleMessage = useCallback(
    (portId: string, portName: string, portKind: PortKind, e: MIDIMessageEvent) => {
      if (!armedRef.current.get(portId)) return
      const data = e.data
      if (!data || data.length === 0) return
      if (data[0] === 0xfe) return // active sensing, drop entirely

      const t = e.timeStamp || performance.now()

      if (data[0] === 0xf8) {
        const clocks = liveClocksRef.current
        clocks.push(t)
        if (clocks.length > LIVE_CLOCK_WINDOW) clocks.shift()
        const bpm = bpmFromClocks(clocks.slice(-LIVE_BPM_SAMPLES))
        const rec = recordingRef.current
        if (rec) rec.clocks.push(t - rec.t0)
        setState((s) => ({ ...s, liveBpm: bpm, midiSeen: true }))
        return
      }

      if ((data[0] & 0xf0) === 0x90 && data[2] > 0) {
        noteHandlerRef.current?.((data[0] & 0x0f) + 1, data[1], portKind)
      }

      const text = describeMessage(data, portKind)
      const rec = recordingRef.current
      if (rec) rec.events.push({ t: t - rec.t0, p: portName, d: Array.from(data) })
      setState((s) => ({
        ...s,
        lastEventText: text,
        midiSeen: true,
        recordedEventCount: rec ? rec.events.length : s.recordedEventCount,
      }))
    },
    [],
  )

  const syncPorts = useCallback(() => {
    const access = accessRef.current
    if (!access) return
    const ports: MidiPortInfo[] = []
    const seen = new Set<string>()
    access.inputs.forEach((p) => {
      seen.add(p.id)
      if (!armedRef.current.has(p.id)) {
        const name = p.name || 'input'
        const kind: PortKind = looksLikeEp136(name)
          ? 'ep136'
          : looksLikeAira(name)
            ? 'aira'
            : 'generic'
        armedRef.current.set(p.id, true)
        kindRef.current.set(p.id, kind)
        p.onmidimessage = (e) => handleMessage(p.id, name, kind, e)
      }
      ports.push({
        id: p.id,
        name: p.name || 'input',
        manufacturer: p.manufacturer || 'unknown',
        state: p.state,
        armed: armedRef.current.get(p.id) ?? true,
        kind: kindRef.current.get(p.id) ?? 'generic',
      })
    })
    for (const id of [...armedRef.current.keys()]) {
      if (!seen.has(id)) {
        armedRef.current.delete(id)
        kindRef.current.delete(id)
      }
    }
    setState((s) => ({ ...s, ports }))
  }, [handleMessage])

  const requestAccess = useCallback(async () => {
    if (!navigator.requestMIDIAccess) {
      setState((s) => ({ ...s, supported: false, error: 'Web MIDI is missing here.' }))
      return
    }
    try {
      const access = await navigator.requestMIDIAccess({ sysex: false })
      accessRef.current = access
      access.onstatechange = syncPorts
      setState((s) => ({ ...s, supported: true, granted: true, error: null }))
      syncPorts()
    } catch (e) {
      setState((s) => ({
        ...s,
        granted: false,
        error: e instanceof Error ? e.message : String(e),
      }))
    }
  }, [syncPorts])

  const setArmed = useCallback((portId: string, armed: boolean) => {
    armedRef.current.set(portId, armed)
    setState((s) => ({
      ...s,
      ports: s.ports.map((p) => (p.id === portId ? { ...p, armed } : p)),
    }))
  }, [])

  const startRecording = useCallback((t0: number) => {
    recordingRef.current = { t0, events: [], clocks: [] }
    setState((s) => ({ ...s, recordedEventCount: 0 }))
  }, [])

  const stopRecording = useCallback((): MidiTakeResult => {
    const rec = recordingRef.current
    recordingRef.current = null
    return rec ? { events: rec.events, clocks: rec.clocks } : { events: [], clocks: [] }
  }, [])

  return { ...state, requestAccess, setArmed, startRecording, stopRecording, setNoteHandler }
}
