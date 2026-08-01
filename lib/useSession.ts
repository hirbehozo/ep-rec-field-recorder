import { useCallback, useEffect, useRef, useState } from 'react'
import { useRecorder } from './audio/useRecorder'
import { useMidi } from './midi/useMidi'
import {
  openWritable,
  putFile,
  readIndex,
  removeSession,
  writeIndex,
  type FileWriter,
} from './store'
import { bpmFromClocks } from './tempo'
import { makeTakeId } from './takeId'
import type { SessionMeta, SessionPayload } from './types'
import { wavHeader } from './wav'

interface CurrentTake {
  id: string
  startedAt: string
  sampleRate: number
}

export function useSession() {
  const recorder = useRecorder()
  const midi = useMidi()
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [offsetMs, setOffsetMs] = useState(0)
  const [recording, setRecording] = useState(false)
  const [lastTakeWarning, setLastTakeWarning] = useState<string | null>(null)

  const takeNoRef = useRef(0)
  const writerRef = useRef<FileWriter | null>(null)
  const memChunksRef = useRef<Uint8Array<ArrayBuffer>[] | null>(null)
  const currentTakeRef = useRef<CurrentTake | null>(null)
  const wakeLockRef = useRef<WakeLockSentinel | null>(null)
  const recordingRef = useRef(false)
  const sessionsRef = useRef<SessionMeta[]>([])

  useEffect(() => {
    readIndex().then((index) => {
      setSessions(index)
      sessionsRef.current = index
      takeNoRef.current = index.reduce((max, s) => Math.max(max, s.n || 0), 0)
    })
  }, [])

  const acquireWakeLock = useCallback(async () => {
    try {
      wakeLockRef.current = await navigator.wakeLock.request('screen')
    } catch {
      wakeLockRef.current = null
    }
  }, [])

  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === 'visible' && recordingRef.current && !wakeLockRef.current) {
        acquireWakeLock()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [acquireWakeLock])

  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (recordingRef.current) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  const start = useCallback(async () => {
    if (recorder.status !== 'ready') return

    takeNoRef.current += 1
    const id = makeTakeId()
    const startedAt = new Date().toISOString()
    const wavName = `${id}.wav`

    const writer = await openWritable(wavName)
    if (writer) {
      writerRef.current = writer
      memChunksRef.current = null
      await writer.write(wavHeader(0, recorder.sampleRate, 2))
    } else {
      writerRef.current = null
      memChunksRef.current = []
    }

    await acquireWakeLock()
    const t0 = performance.now()
    currentTakeRef.current = { id, startedAt, sampleRate: recorder.sampleRate }

    recorder.start((chunk) => {
      if (writerRef.current) writerRef.current.write(chunk.bytes).catch(() => {})
      else memChunksRef.current?.push(chunk.bytes)
    })
    midi.startRecording(t0)

    recordingRef.current = true
    setRecording(true)
    setLastTakeWarning(null)
  }, [recorder, midi, acquireWakeLock])

  const stop = useCallback(async () => {
    const take = currentTakeRef.current
    if (!recordingRef.current || !take) return

    const result = await recorder.stop()
    const frames = result?.frames ?? 0
    const midiResult = midi.stopRecording()

    const dataBytes = frames * 4
    const wavName = `${take.id}.wav`
    const midiName = `${take.id}.midi.json`
    let mem = false

    if (writerRef.current) {
      await writerRef.current.writeAt(0, wavHeader(dataBytes, take.sampleRate, 2))
      await writerRef.current.close()
      writerRef.current = null
    } else {
      mem = true
      const blob = new Blob(
        [wavHeader(dataBytes, take.sampleRate, 2), ...(memChunksRef.current ?? [])],
        { type: 'audio/wav' },
      )
      await putFile(wavName, blob)
      memChunksRef.current = null
    }

    const bpm = bpmFromClocks(midiResult.clocks)
    const ports = [...new Set(midiResult.events.map((e) => e.p))]

    const meta: SessionMeta = {
      id: take.id,
      n: takeNoRef.current,
      startedAt: take.startedAt,
      duration: take.sampleRate ? frames / take.sampleRate : 0,
      sampleRate: take.sampleRate,
      channels: 2,
      device: recorder.deviceLabel,
      bpm,
      clipped: recorder.clipped,
      offsetMs,
      events: midiResult.events.length,
      ports,
      wav: wavName,
      midi: midiName,
      mem,
    }
    const payload: SessionPayload = { meta, events: midiResult.events, clocks: midiResult.clocks }
    await putFile(midiName, new Blob([JSON.stringify(payload)], { type: 'application/json' }))

    const nextSessions = [meta, ...sessionsRef.current]
    sessionsRef.current = nextSessions
    setSessions(nextSessions)
    await writeIndex(nextSessions)

    if (wakeLockRef.current) {
      await wakeLockRef.current.release().catch(() => {})
      wakeLockRef.current = null
    }

    currentTakeRef.current = null
    recordingRef.current = false
    setRecording(false)
    setLastTakeWarning(
      frames === 0
        ? 'That take captured no audio. The selected input is not delivering samples.'
        : null,
    )
  }, [recorder, midi, offsetMs])

  const removeTake = useCallback(async (meta: SessionMeta) => {
    await removeSession(meta)
    const next = sessionsRef.current.filter((s) => s.id !== meta.id)
    sessionsRef.current = next
    setSessions(next)
    await writeIndex(next)
  }, [])

  return {
    recorder,
    midi,
    sessions,
    recording,
    offsetMs,
    setOffsetMs,
    lastTakeWarning,
    start,
    stop,
    removeTake,
  }
}
