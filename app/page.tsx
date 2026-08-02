'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Display from './components/Display'
import { looksLikeHardware } from '@/lib/audio/deviceHint'
import {
  exportAllZip,
  exportJson,
  exportMidi,
  exportMp3,
  exportWav,
  shareOrDownload,
} from '@/lib/export'
import { isPersistent } from '@/lib/store'
import { useSession } from '@/lib/useSession'
import type { SessionMeta } from '@/lib/types'

type ExportKind = 'wav' | 'mid' | 'json' | 'zip'

interface AudioDeviceInfo {
  deviceId: string
  label: string
}

const OFFSET_MIN = -500
const OFFSET_MAX = 500
const OFFSET_STEP = 5
const MP3_BITRATES = [128, 192, 256, 320] as const
const DEFAULT_MP3_BITRATE = 192

const pad = (n: number, w: number) => String(n).padStart(w, '0')
const hms = (s: number) =>
  `${pad(Math.floor(s / 3600), 2)}:${pad(Math.floor(s / 60) % 60, 2)}:${pad(Math.floor(s) % 60, 2)}`

function buzz(ms: number): void {
  try {
    navigator.vibrate?.(ms)
  } catch {
    // vibration is a nicety, never worth failing over
  }
}

export default function Home() {
  const session = useSession()
  const [audioDevices, setAudioDevices] = useState<AudioDeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState('')
  const [scanning, setScanning] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)
  const [persistent, setPersistent] = useState<boolean | null>(null)
  const [mp3Bitrate, setMp3Bitrate] = useState(DEFAULT_MP3_BITRATE)
  // take id -> 0..1 while that take's MP3 is encoding; absent otherwise
  const [mp3Progress, setMp3Progress] = useState<Record<string, number>>({})

  useEffect(() => {
    isPersistent().then(setPersistent)
  }, [])

  const scanHardware = useCallback(async (): Promise<boolean> => {
    setPageError(null)
    if (!window.isSecureContext) {
      setPageError(
        'This page needs https or localhost before the browser will hand over MIDI and audio.',
      )
      return false
    }

    await session.midi.requestAccess()

    let devices: AudioDeviceInfo[] = []
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
      probe.getTracks().forEach((t) => t.stop())
      const all = await navigator.mediaDevices.enumerateDevices()
      devices = all
        .filter((d) => d.kind === 'audioinput')
        .map((d) => ({ deviceId: d.deviceId, label: d.label || `input ${d.deviceId.slice(0, 6)}` }))
      setAudioDevices(devices)
    } catch (e) {
      setPageError(
        `Audio permission was refused, so nothing can be recorded: ${e instanceof Error ? e.message : String(e)}`,
      )
      return false
    }

    if (!devices.length) {
      setPageError(
        'No audio input devices were found. Check the USB cable and that the OS sees the interface.',
      )
      return false
    }

    const guess = devices.find((d) => looksLikeHardware(d.label)) ?? devices[0]
    setSelectedDeviceId(guess.deviceId)
    try {
      await session.recorder.openDevice(guess.deviceId)
    } catch {
      return false
    }
    return true
  }, [session.midi, session.recorder])

  const onRecordKey = useCallback(async () => {
    if (session.recording) {
      buzz(12)
      await session.stop()
      return
    }
    if (session.recorder.status !== 'ready') {
      setScanning(true)
      const ok = await scanHardware()
      setScanning(false)
      if (!ok) return
    }
    buzz(22)
    await session.start()
  }, [session, scanHardware])

  const onScanKey = useCallback(() => {
    scanHardware()
  }, [scanHardware])

  const onDeviceChange = useCallback(
    (deviceId: string) => {
      setSelectedDeviceId(deviceId)
      session.recorder.openDevice(deviceId).catch(() => {})
    },
    [session.recorder],
  )

  const nudgeOffset = useCallback(
    (delta: number) => {
      buzz(6)
      session.setOffsetMs((v) => Math.max(OFFSET_MIN, Math.min(OFFSET_MAX, v + delta)))
    },
    [session],
  )

  const onDeleteTake = useCallback(
    async (meta: SessionMeta) => {
      if (!window.confirm(`Delete take ${pad(meta.n || 0, 2)}? This cannot be undone.`)) return
      await session.removeTake(meta)
    },
    [session],
  )

  const onExport = useCallback(
    async (meta: SessionMeta, kind: ExportKind) => {
      setPageError(null)
      try {
        // MIDI (and the zip that bundles it) is built on demand from the
        // live offset, not the offset the take was recorded with, so
        // nudging the offset and re-exporting an old take shifts it
        // correctly.
        const file =
          kind === 'wav'
            ? await exportWav(meta)
            : kind === 'mid'
              ? await exportMidi(meta, session.offsetMs)
              : kind === 'json'
                ? await exportJson(meta)
                : await exportAllZip(meta, session.offsetMs)
        await shareOrDownload(file)
      } catch (e) {
        setPageError(`Export failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
    [session.offsetMs],
  )

  const onExportMp3 = useCallback(
    async (meta: SessionMeta) => {
      setPageError(null)
      setMp3Progress((p) => ({ ...p, [meta.id]: 0 }))
      try {
        const file = await exportMp3(meta, mp3Bitrate, (fraction) => {
          setMp3Progress((p) => ({ ...p, [meta.id]: fraction }))
        })
        await shareOrDownload(file)
      } catch (e) {
        setPageError(`MP3 encoding failed: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setMp3Progress((p) => {
          const next = { ...p }
          delete next[meta.id]
          return next
        })
      }
    },
    [mp3Bitrate],
  )

  const messages = useMemo(() => {
    const list: { text: string; quiet: boolean }[] = []
    if (persistent === false) {
      list.push({
        text: 'Persistent storage is unavailable, so takes live in memory only. Export before you close the tab.',
        quiet: false,
      })
    }
    if (pageError) list.push({ text: pageError, quiet: false })
    if (session.recorder.error) list.push({ text: session.recorder.error, quiet: false })
    if (session.recorder.deviceMessage)
      list.push({ text: session.recorder.deviceMessage, quiet: true })
    if (session.midi.error) list.push({ text: session.midi.error, quiet: false })
    if (session.lastTakeWarning) list.push({ text: session.lastTakeWarning, quiet: false })
    return list
  }, [
    persistent,
    pageError,
    session.recorder.error,
    session.recorder.deviceMessage,
    session.midi.error,
    session.lastTakeWarning,
  ])

  const deviceOpen = session.recorder.status === 'ready' || session.recorder.status === 'recording'

  return (
    <div className="panel-case">
      <div className="flex items-end gap-[9px] px-px pt-[13px] pb-[11px]">
        <span className="identity">
          EP<span className="text-signal">&ndash;</span>REC
        </span>
        <span className="legend-text pb-0.5">field recorder</span>
        <span className="legend-text ml-auto pb-0.5">01</span>
      </div>

      <Display
        recording={session.recording}
        deviceOpen={deviceOpen}
        sampleRate={session.recorder.sampleRate}
        channelCount={session.recorder.channelCount}
        frames={session.recorder.frames}
        peakL={session.recorder.peakL}
        peakR={session.recorder.peakR}
        clipped={session.recorder.clipped}
        liveBpm={session.midi.liveBpm}
        midiSeen={session.midi.midiSeen}
        recordedEventCount={session.midi.recordedEventCount}
        lastEventText={session.midi.lastEventText}
      />

      <div className="mt-[11px] grid grid-cols-[1fr_84px] gap-[9px]">
        <button
          type="button"
          className={`key wide rec${session.recording ? ' armed' : ''}`}
          onClick={() => onRecordKey()}
        >
          {scanning ? 'Wait' : session.recording ? 'Stop' : 'Record'}
        </button>
        <button type="button" className="key wide" onClick={onScanKey} disabled={scanning}>
          Scan
        </button>
      </div>

      {messages.length > 0 && (
        <div>
          {messages.map((m, i) => (
            <div key={i} className={`panel-msg${m.quiet ? ' quiet' : ''}`}>
              {m.text}
            </div>
          ))}
        </div>
      )}

      <div className="section-hdr">
        <span className="tag">Input</span>
        <span className="rule" />
        <span className="val">{deviceOpen ? 'live' : 'standby'}</span>
      </div>
      <div>
        <div className="strip">
          <span className="n">1</span>
          <div>
            <span className="lg">Audio source</span>
            <select
              className="panel-select"
              value={selectedDeviceId}
              onChange={(e) => onDeviceChange(e.target.value)}
              disabled={audioDevices.length === 0}
            >
              {audioDevices.length === 0 ? (
                <option>press scan to list devices</option>
              ) : (
                audioDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))
              )}
            </select>
          </div>
        </div>
        <div className="strip">
          <span className="n">2</span>
          <div>
            <span className="lg">Midi ports</span>
            <div className="flex flex-wrap gap-[7px]">
              {session.midi.ports.length === 0 && (
                <span className="text-[11px] font-semibold text-legend">
                  No ports found. Check the USB cable.
                </span>
              )}
              {session.midi.ports.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="key mini chip"
                  aria-pressed={p.armed}
                  onClick={() => {
                    session.midi.setArmed(p.id, !p.armed)
                    buzz(8)
                  }}
                >
                  <span className="led" />
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="strip">
          <span className="n">4</span>
          <div>
            <span className="lg">Mp3 bitrate</span>
            <select
              className="panel-select"
              value={mp3Bitrate}
              onChange={(e) => setMp3Bitrate(Number(e.target.value))}
            >
              {MP3_BITRATES.map((rate) => (
                <option key={rate} value={rate}>
                  {rate} kbps
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="strip">
          <span className="n">3</span>
          <div>
            <span className="lg">Midi offset</span>
            <div className="nudge">
              <button type="button" className="key mini" onClick={() => nudgeOffset(-OFFSET_STEP)}>
                &minus;5
              </button>
              <span className="read">
                {session.offsetMs > 0 ? '+' : ''}
                {session.offsetMs} ms
              </span>
              <button type="button" className="key mini" onClick={() => nudgeOffset(OFFSET_STEP)}>
                +5
              </button>
              <span className="hint">vs audio</span>
            </div>
          </div>
        </div>
      </div>

      <div className="section-hdr">
        <span className="tag">Takes</span>
        <span className="rule" />
        <span className="val">
          {session.sessions.length ? `${session.sessions.length} stored` : 'none'}
        </span>
      </div>
      {session.sessions.length > 0 && (
        <p className="legend-text -mt-1 mb-2">json carries the mixer automation, not just wav</p>
      )}
      <div>
        {session.sessions.length === 0 ? (
          <div className="empty-state">
            Nothing recorded yet. Plug the Sidekick into the USB-C port and press record.
          </div>
        ) : (
          session.sessions.map((m) => {
            const when = new Date(m.startedAt)
            return (
              <div key={m.id} className="take-row">
                <div className="top">
                  <span className="n">{pad(m.n || 0, 2)}</span>
                  <span className="dur">{hms(m.duration)}</span>
                  <span className="when">
                    {when.toLocaleDateString()} {pad(when.getHours(), 2)}:
                    {pad(when.getMinutes(), 2)}
                  </span>
                </div>
                <div className="meta">
                  <b>{m.events}</b> events / {m.bpm ? <b>{m.bpm}</b> : 'free tempo'}
                  {m.bpm ? ' bpm' : ''}
                  {m.ports.length ? ` / ${m.ports.join(', ')}` : ''}
                  {m.clipped ? (
                    <>
                      {' '}
                      / <b>clipped</b>
                    </>
                  ) : null}
                  {m.writeErrors > 0 ? (
                    <>
                      {' '}
                      /{' '}
                      <b>
                        {m.writeErrors} write error{m.writeErrors === 1 ? '' : 's'}
                      </b>
                    </>
                  ) : null}
                  {m.missingFrames > 0 ? (
                    <>
                      {' '}
                      / <b>gap</b>
                    </>
                  ) : null}
                </div>
                <div className="acts">
                  {(() => {
                    const encoding = mp3Progress[m.id]
                    const busy = encoding !== undefined
                    return (
                      <>
                        <button
                          type="button"
                          className="key mini"
                          disabled={busy}
                          onClick={() => onExport(m, 'wav')}
                        >
                          wav
                        </button>
                        <button
                          type="button"
                          className="key mini"
                          disabled={busy}
                          onClick={() => onExportMp3(m)}
                        >
                          {busy ? `${Math.round(encoding * 100)}%` : 'mp3'}
                        </button>
                        <button
                          type="button"
                          className="key mini"
                          disabled={busy}
                          onClick={() => onExport(m, 'mid')}
                        >
                          midi
                        </button>
                        <button
                          type="button"
                          className="key mini"
                          disabled={busy}
                          onClick={() => onExport(m, 'json')}
                        >
                          json
                        </button>
                        <button
                          type="button"
                          className="key mini"
                          disabled={busy}
                          onClick={() => onExport(m, 'zip')}
                        >
                          all
                        </button>
                        <button
                          type="button"
                          className="key mini del"
                          disabled={busy}
                          onClick={() => onDeleteTake(m)}
                        >
                          delete
                        </button>
                      </>
                    )
                  })()}
                </div>
              </div>
            )
          })
        )}
      </div>

      <div className="section-hdr">
        <span className="tag">Signal</span>
        <span className="rule" />
      </div>
      <div className="diag-list">
        <div className="row">
          <i className="k">web midi</i>
          <span className={session.midi.granted ? 'ok' : 'bad'}>
            {session.midi.granted
              ? `${session.midi.ports.length} port${session.midi.ports.length === 1 ? '' : 's'}`
              : 'unavailable'}
          </span>
        </div>
        <div className="row">
          <i className="k">audio in</i>
          <span className={deviceOpen ? 'ok' : 'bad'}>
            {deviceOpen
              ? `${session.recorder.channelCount} ch / ${(session.recorder.sampleRate / 1000).toFixed(1)} kHz`
              : 'not open'}
          </span>
        </div>
        <div className="row">
          <i className="k">storage</i>
          <span className={persistent ? 'ok' : 'bad'}>
            {persistent === null ? 'checking' : persistent ? 'origin private fs' : 'memory only'}
          </span>
        </div>
        <div className="row">
          <i className="k">screen lock</i>
          <span className={session.wakeLockHeld ? 'ok' : 'bad'}>
            {session.wakeLockHeld ? 'held' : 'released'}
          </span>
        </div>
        {session.recorder.deviceLabel && (
          <div className="row">
            <i className="k">device</i>
            <span>{session.recorder.deviceLabel}</span>
          </div>
        )}
      </div>
    </div>
  )
}
