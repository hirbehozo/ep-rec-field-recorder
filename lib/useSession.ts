import { useCallback, useEffect, useRef, useState } from 'react'
import { useRecorder } from './audio/useRecorder'
import { WriterClient } from './audio/writerClient'
import { useMidi } from './midi/useMidi'
import { getWritableHandle, putFile, readIndex, removeSession, writeIndex } from './store'
import { bpmFromClocks } from './tempo'
import { makeTakeId } from './takeId'
import type { SessionMeta, SessionPayload } from './types'
import { BYTES_PER_SAMPLE, interleave, wavHeader } from './wav'

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
  const [wakeLockHeld, setWakeLockHeld] = useState(false)

  const takeNoRef = useRef(0)
  const writerClientRef = useRef<WriterClient | null>(null)
  const memChunksRef = useRef<Uint8Array<ArrayBuffer>[] | null>(null)
  const currentTakeRef = useRef<CurrentTake | null>(null)
  const wakeLockRef = useRef<WakeLockSentinel | null>(null)
  const recordingRef = useRef(false)
  const sessionsRef = useRef<SessionMeta[]>([])

  // start()/stop() can run across an awaited hardware scan, by which point a
  // handler created before the scan would otherwise close over pre-scan
  // recorder data (status not yet 'ready', sampleRate still 0). Mirroring
  // into a ref keeps every closure reading the current value at call time.
  const recorderStateRef = useRef(recorder)
  recorderStateRef.current = recorder

  useEffect(() => {
    readIndex().then((index) => {
      setSessions(index)
      sessionsRef.current = index
      takeNoRef.current = index.reduce((max, s) => Math.max(max, s.n || 0), 0)
    })
  }, [])

  const acquireWakeLock = useCallback(async () => {
    try {
      const lock = await navigator.wakeLock.request('screen')
      lock.onrelease = () => {
        wakeLockRef.current = null
        setWakeLockHeld(false)
      }
      wakeLockRef.current = lock
      setWakeLockHeld(true)
    } catch {
      wakeLockRef.current = null
      setWakeLockHeld(false)
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
    if (recorderStateRef.current.status !== 'ready') return

    takeNoRef.current += 1
    const id = makeTakeId()
    const startedAt = new Date().toISOString()
    const wavName = `${id}.wav`
    const sampleRate = recorderStateRef.current.sampleRate

    // PCM conversion and the actual file write happen off the main thread
    // in a dedicated worker via OPFS createSyncAccessHandle, so a slow
    // render can never stall a disk write. Falls back to accumulating
    // converted chunks in memory (built into one file on stop) when OPFS is
    // unavailable, or if the worker fails to open the handle.
    const fileHandle = await getWritableHandle(wavName)
    if (fileHandle) {
      const client = new WriterClient()
      try {
        await client.open(fileHandle, sampleRate, 2)
        writerClientRef.current = client
        memChunksRef.current = null
      } catch {
        writerClientRef.current = null
        memChunksRef.current = []
      }
    } else {
      writerClientRef.current = null
      memChunksRef.current = []
    }

    await acquireWakeLock()
    const t0 = performance.now()
    currentTakeRef.current = { id, startedAt, sampleRate }

    recorder.start((chunk) => {
      if (writerClientRef.current) {
        writerClientRef.current.writeChunk(chunk.l, chunk.r, chunk.frames)
      } else {
        memChunksRef.current?.push(interleave(chunk.l, chunk.r, chunk.frames))
      }
    })
    midi.startRecording(t0)

    recordingRef.current = true
    setRecording(true)
    setLastTakeWarning(null)
  }, [recorder, midi, acquireWakeLock])

  const stop = useCallback(async () => {
    const take = currentTakeRef.current
    if (!recordingRef.current || !take) return

    const captureResult = await recorder.stop()
    const capturedFrames = captureResult?.frames ?? 0
    const missingFrames = captureResult?.missingFrames ?? 0
    const peakSession = captureResult?.peakSession ?? 0
    const midiResult = midi.stopRecording()

    const wavName = `${take.id}.wav`
    const midiName = `${take.id}.midi.json`
    let mem = false
    let writeErrors = 0
    // Durably-persisted frame count, which can be less than capturedFrames
    // if any writes failed — duration reflects what's actually in the file.
    let frames = capturedFrames

    if (writerClientRef.current) {
      const closeResult = await writerClientRef.current.close()
      writeErrors = closeResult.writeErrors
      frames = closeResult.frames
      writerClientRef.current = null
    } else {
      mem = true
      const dataBytes = capturedFrames * 2 * BYTES_PER_SAMPLE
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
      device: recorderStateRef.current.deviceLabel,
      bpm,
      clipped: recorderStateRef.current.clipped,
      offsetMs,
      events: midiResult.events.length,
      ports,
      wav: wavName,
      midi: midiName,
      mem,
      writeErrors,
      missingFrames,
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
      setWakeLockHeld(false)
    }

    currentTakeRef.current = null
    recordingRef.current = false
    setRecording(false)
    setLastTakeWarning(
      capturedFrames === 0
        ? 'That take captured no audio. The selected input is not delivering samples.'
        : peakSession < 0.03
          ? 'That take peaked below -30 dBFS. Turn up the Sidekick gain before the next one.'
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
    wakeLockHeld,
    start,
    stop,
    removeTake,
  }
}
