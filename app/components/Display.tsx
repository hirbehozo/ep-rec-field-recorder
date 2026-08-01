'use client'

import { useEffect, useRef } from 'react'
import { DM_COLS, DM_ROWS, DotMatrix } from '@/lib/dotmatrix'

export interface DisplayProps {
  recording: boolean
  deviceOpen: boolean
  sampleRate: number
  channelCount: number
  frames: number
  peakL: number
  peakR: number
  clipped: boolean
  liveBpm: number | null
  recordedEventCount: number
  lastEventText: string
}

interface MeterState {
  currentL: number
  currentR: number
  holdL: number
  holdR: number
}

const pad = (n: number, w: number) => String(n).padStart(w, '0')
const hms = (s: number) =>
  `${pad(Math.floor(s / 3600), 2)}:${pad(Math.floor(s / 60) % 60, 2)}:${pad(Math.floor(s) % 60, 2)}`
const dbOf = (p: number) => (p > 0 ? 20 * Math.log10(p) : -100)
const scaleOf = (db: number) => Math.max(0, Math.min(1, (db + 60) / 60))

const LAMP_TEST_MS = 240
const WIPE_END_MS = 460
const PAINT_INTERVAL_MS = 32 // ~30fps

function paint(
  dm: DotMatrix,
  live: DisplayProps,
  meter: MeterState,
  bootTs: number,
  reducedMotion: boolean,
): void {
  const now = performance.now()
  const age = reducedMotion ? Infinity : now - bootTs
  dm.clear()

  if (age < LAMP_TEST_MS) {
    dm.fill()
    dm.render()
    return
  }
  if (age < WIPE_END_MS) {
    const cut = Math.floor(((age - LAMP_TEST_MS) / (WIPE_END_MS - LAMP_TEST_MS)) * DM_ROWS)
    for (let y = cut; y < DM_ROWS; y++) for (let x = 0; x < DM_COLS; x++) dm.plot(x, y, 1)
    dm.render()
    return
  }

  const blink = reducedMotion ? true : Math.floor(now / 500) % 2 === 0
  const state = live.recording ? 'REC' : live.deviceOpen ? 'RDY' : 'OFF'
  if (!live.recording || blink) dm.char('#', 0, 0, 1, live.recording ? 2 : 1)
  dm.text(state, 8, 0, 1, 1)
  if (live.clipped && blink) dm.right('CLIP', DM_COLS, 0, 1, 2)
  else if (live.sampleRate)
    dm.right(`${(live.sampleRate / 1000).toFixed(1)}K ${live.channelCount}CH`, DM_COLS, 0, 1, 1)
  else dm.right('NO INPUT', DM_COLS, 0, 1, 1)

  const secs = live.sampleRate ? live.frames / live.sampleRate : 0
  // full hh:mm:ss at double scale spans the display edge to edge
  dm.text(hms(secs), 1, 8, 2, 1)

  // meters, with a slow-falling peak hold tick
  meter.holdL = Math.max(meter.holdL * 0.985, meter.currentL)
  meter.holdR = Math.max(meter.holdR * 0.985, meter.currentR)
  dm.char('L', 0, 23, 1, 1)
  dm.bar(8, DM_COLS - 1, 25, 3, scaleOf(dbOf(meter.currentL)), 0.86)
  dm.char('R', 0, 31, 1, 1)
  dm.bar(8, DM_COLS - 1, 33, 3, scaleOf(dbOf(meter.currentR)), 0.86)
  for (const [hold, y] of [
    [meter.holdL, 25],
    [meter.holdR, 33],
  ] as const) {
    const x = 8 + Math.round(scaleOf(dbOf(hold)) * (DM_COLS - 9))
    for (let r = 0; r < 3; r++) dm.plot(Math.min(DM_COLS - 1, x), y + r, 2)
  }

  dm.text(live.liveBpm ? `BPM${live.liveBpm.toFixed(1)}` : 'BPM ---', 0, 39, 1, 1)
  dm.right(`EV${live.recording ? live.recordedEventCount : 0}`, DM_COLS, 39, 1, 1)
  dm.text((live.lastEventText || 'NO MIDI IN').slice(0, 16), 0, 47, 1, 1)

  meter.currentL *= 0.72
  meter.currentR *= 0.72

  dm.render()
}

export default function Display(props: DisplayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dmRef = useRef<DotMatrix | null>(null)
  const liveRef = useRef(props)
  const meterRef = useRef<MeterState>({ currentL: 0, currentR: 0, holdL: 0, holdR: 0 })
  const reducedMotionRef = useRef(false)
  const bootTsRef = useRef(0)

  liveRef.current = props
  meterRef.current.currentL = Math.max(meterRef.current.currentL, props.peakL)
  meterRef.current.currentR = Math.max(meterRef.current.currentR, props.peakR)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dm = new DotMatrix()
    dmRef.current = dm
    bootTsRef.current = performance.now()

    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    reducedMotionRef.current = mq.matches
    const onMotionChange = () => {
      reducedMotionRef.current = mq.matches
    }
    mq.addEventListener('change', onMotionChange)

    const onResize = () => dm.resize(canvas)
    onResize()
    window.addEventListener('resize', onResize)

    let rafId = 0
    let lastPaint = 0
    const frame = (ts: number) => {
      if (ts - lastPaint > PAINT_INTERVAL_MS) {
        lastPaint = ts
        paint(dm, liveRef.current, meterRef.current, bootTsRef.current, reducedMotionRef.current)
      }
      rafId = requestAnimationFrame(frame)
    }
    rafId = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', onResize)
      mq.removeEventListener('change', onMotionChange)
    }
  }, [])

  return (
    <div className="screen">
      <canvas ref={canvasRef} aria-hidden="true" />
    </div>
  )
}
