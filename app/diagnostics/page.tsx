'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { HARDWARE_HINT } from '@/lib/audio/deviceHint'

type PassFail = 'unknown' | 'pass' | 'fail'

interface AudioDeviceInfo {
  deviceId: string
  label: string
}

interface MidiPortInfo {
  id: string
  name: string
  manufacturer: string
  state: MIDIPortDeviceState
}

interface TrackDiagnostics {
  deviceLabel: string
  sampleRate: number
  channelCount: number
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
  presetLabel: string
}

// Confirmed on real hardware: explicitly disabling echoCancellation breaks
// Android's device routing entirely — getUserMedia reports the requested
// USB device as open with matching settings while silently capturing the
// phone's built-in mic instead. noiseSuppression/autoGainControl can both
// be disabled safely; echoCancellation cannot. This matches what
// lib/audio/useRecorder.ts now requests. The other presets stay here for
// troubleshooting different hardware, where the answer may differ.
const PRESETS: Record<string, { label: string; constraints: MediaTrackConstraints }> = {
  recommended: {
    label: 'recommended (AEC default, NS/AGC off, stereo ideal)',
    constraints: { noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } },
  },
  processed: {
    label: 'fully processed (AEC/NS/AGC all default, stereo ideal)',
    constraints: { channelCount: { ideal: 2 } },
  },
  allOff: {
    label: 'all off (AEC/NS/AGC off, stereo ideal) — routing may fail',
    constraints: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 },
    },
  },
  monoExact: {
    label: 'all off, mono exact — routing may fail',
    constraints: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { exact: 1 },
    },
  },
  // Isolate which single flag actually breaks device routing on whatever
  // hardware this is running against, rather than assuming it matches the
  // phone this was first diagnosed on.
  aecOnlyDefault: {
    label: 'only AEC at default (NS/AGC off)',
    constraints: { noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } },
  },
  nsOnlyDefault: {
    label: 'only NS at default (AEC/AGC off)',
    constraints: { echoCancellation: false, autoGainControl: false, channelCount: { ideal: 2 } },
  },
  agcOnlyDefault: {
    label: 'only AGC at default (AEC/NS off)',
    constraints: { echoCancellation: false, noiseSuppression: false, channelCount: { ideal: 2 } },
  },
}
const PRESET_KEYS = Object.keys(PRESETS)
const DEFAULT_PRESET = 'recommended'

interface LogMessage {
  id: number
  text: string
  tone: 'bad' | 'info'
}

interface AudioGraph {
  stream: MediaStream
  ctx: AudioContext
  source: MediaStreamAudioSourceNode
  splitter: ChannelSplitterNode
  analyserL: AnalyserNode
  analyserR: AnalyserNode
  sink: GainNode
}

function DiagLine({
  label,
  status,
  detail,
  hint,
}: {
  label: string
  status: PassFail
  detail: string
  hint?: string
}) {
  const color =
    status === 'pass' ? 'text-emerald-400' : status === 'fail' ? 'text-red-400' : 'text-zinc-500'
  return (
    <div className="border-b border-zinc-800 py-2 last:border-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          {label}
        </span>
        <span className={`text-right text-sm font-medium ${color}`}>{detail}</span>
      </div>
      {status === 'fail' && hint && <p className="mt-1 text-xs text-zinc-500">{hint}</p>}
    </div>
  )
}

export default function DiagnosticsPage() {
  const [secureContext, setSecureContext] = useState<PassFail>('unknown')
  const [opfsStatus, setOpfsStatus] = useState<PassFail>('unknown')
  const [opfsError, setOpfsError] = useState('')
  const [wakeLockStatus, setWakeLockStatus] = useState<PassFail>('unknown')
  const [wakeLockError, setWakeLockError] = useState('')

  const [midiStatus, setMidiStatus] = useState<'idle' | 'granted' | 'denied' | 'unsupported'>(
    'idle',
  )
  const [midiError, setMidiError] = useState('')
  const [midiPorts, setMidiPorts] = useState<MidiPortInfo[]>([])

  const [audioDevices, setAudioDevices] = useState<AudioDeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState('')
  const [audioStatus, setAudioStatus] = useState<'idle' | 'open' | 'error'>('idle')
  const [audioError, setAudioError] = useState('')
  const [trackDiag, setTrackDiag] = useState<TrackDiagnostics | null>(null)

  const [preset, setPreset] = useState(DEFAULT_PRESET)
  const [connecting, setConnecting] = useState(false)
  const [messages, setMessages] = useState<LogMessage[]>([])
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  const midiAccessRef = useRef<MIDIAccess | null>(null)
  const graphRef = useRef<AudioGraph | null>(null)
  const rafRef = useRef<number | null>(null)
  const barLRef = useRef<HTMLDivElement | null>(null)
  const barRRef = useRef<HTMLDivElement | null>(null)
  const readLRef = useRef<HTMLSpanElement | null>(null)
  const readRRef = useRef<HTMLSpanElement | null>(null)
  const clipRef = useRef({ l: false, r: false })
  const msgIdRef = useRef(0)

  const log = useCallback((text: string, tone: 'bad' | 'info' = 'bad') => {
    msgIdRef.current += 1
    setMessages((m) => [...m, { id: msgIdRef.current, text, tone }])
  }, [])

  const refreshMidiPorts = useCallback(() => {
    const access = midiAccessRef.current
    if (!access) return
    const ports: MidiPortInfo[] = []
    access.inputs.forEach((p) => {
      ports.push({
        id: p.id,
        name: p.name || 'input',
        manufacturer: p.manufacturer || 'unknown',
        state: p.state,
      })
    })
    setMidiPorts(ports)
  }, [])

  const closeAudioGraph = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    const g = graphRef.current
    if (g) {
      g.stream.getTracks().forEach((t) => t.stop())
      g.ctx.close().catch(() => {})
      graphRef.current = null
    }
    setAudioStatus('idle')
    setTrackDiag(null)
  }, [])

  const meterLoop = useCallback(() => {
    const g = graphRef.current
    if (!g) return
    const bufL = new Float32Array(g.analyserL.fftSize)
    const bufR = new Float32Array(g.analyserR.fftSize)
    const tick = () => {
      const graph = graphRef.current
      if (!graph) return
      graph.analyserL.getFloatTimeDomainData(bufL)
      graph.analyserR.getFloatTimeDomainData(bufR)
      let peakL = 0
      let peakR = 0
      for (let i = 0; i < bufL.length; i++) {
        const a = Math.abs(bufL[i])
        if (a > peakL) peakL = a
      }
      for (let i = 0; i < bufR.length; i++) {
        const a = Math.abs(bufR[i])
        if (a > peakR) peakR = a
      }
      if (peakL >= 0.999) clipRef.current.l = true
      if (peakR >= 0.999) clipRef.current.r = true
      const pctL = Math.max(0, Math.min(100, peakL * 100))
      const pctR = Math.max(0, Math.min(100, peakR * 100))
      if (barLRef.current) barLRef.current.style.width = `${pctL}%`
      if (barRRef.current) barRRef.current.style.width = `${pctR}%`
      if (readLRef.current)
        readLRef.current.textContent = clipRef.current.l ? 'CLIP' : pctL.toFixed(0) + '%'
      if (readRRef.current)
        readRRef.current.textContent = clipRef.current.r ? 'CLIP' : pctR.toFixed(0) + '%'
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  const openAudioDevice = useCallback(
    async (deviceId: string, presetKey: string) => {
      closeAudioGraph()
      clipRef.current = { l: false, r: false }
      const constraints: MediaTrackConstraints = { ...PRESETS[presetKey].constraints }
      if (deviceId) constraints.deviceId = { exact: deviceId }
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: constraints })
      } catch (e) {
        setAudioStatus('error')
        setAudioError(e instanceof Error ? e.message : String(e))
        log(
          `Could not open that input: ${e instanceof Error ? e.message : String(e)}. Check that no other app is holding the device and that Chrome has microphone permission for this site.`,
        )
        return
      }
      const track = stream.getAudioTracks()[0]
      const settings = track.getSettings()
      track.onended = () => {
        log('The audio input disappeared. Check the USB cable, then press Connect again.')
        closeAudioGraph()
      }
      let ctx: AudioContext
      try {
        ctx = settings.sampleRate
          ? new AudioContext({ sampleRate: settings.sampleRate, latencyHint: 'interactive' })
          : new AudioContext({ latencyHint: 'interactive' })
      } catch {
        ctx = new AudioContext()
      }
      await ctx.resume()
      const source = ctx.createMediaStreamSource(stream)
      const splitter = ctx.createChannelSplitter(2)
      source.connect(splitter)
      const analyserL = ctx.createAnalyser()
      analyserL.fftSize = 1024
      const channelCount = settings.channelCount ?? 1
      let analyserR: AnalyserNode
      if (channelCount >= 2) {
        analyserR = ctx.createAnalyser()
        analyserR.fftSize = 1024
        splitter.connect(analyserL, 0)
        splitter.connect(analyserR, 1)
      } else {
        splitter.connect(analyserL, 0)
        analyserR = analyserL
      }
      // keep the graph pulled by the audio engine, same fix as the prototype's
      // AudioWorkletNode: an unreachable-from-destination node can stop processing.
      const sink = ctx.createGain()
      sink.gain.value = 0
      source.connect(sink)
      sink.connect(ctx.destination)

      graphRef.current = { stream, ctx, source, splitter, analyserL, analyserR, sink }
      setAudioStatus('open')
      setTrackDiag({
        deviceLabel: track.label || 'unnamed input',
        sampleRate: settings.sampleRate ?? ctx.sampleRate,
        channelCount,
        echoCancellation: settings.echoCancellation ?? false,
        noiseSuppression: settings.noiseSuppression ?? false,
        autoGainControl: settings.autoGainControl ?? false,
        presetLabel: PRESETS[presetKey].label,
      })
      setSelectedDeviceId(deviceId)
      setPreset(presetKey)
      if (!HARDWARE_HINT.test(track.label)) {
        log(
          'That input looks like the phone microphone rather than the Sidekick. Pick the USB device from the list above.',
          'info',
        )
      }
      meterLoop()
    },
    [closeAudioGraph, log, meterLoop],
  )

  const connect = useCallback(async () => {
    setMessages([])
    setConnecting(true)
    try {
      if (!window.isSecureContext) {
        log('This page needs https or localhost before the browser will hand over MIDI and audio.')
        return
      }
      if (navigator.requestMIDIAccess) {
        try {
          const access = await navigator.requestMIDIAccess({ sysex: false })
          midiAccessRef.current = access
          access.onstatechange = refreshMidiPorts
          setMidiStatus('granted')
          refreshMidiPorts()
        } catch (e) {
          setMidiStatus('denied')
          const message = e instanceof Error ? e.message : String(e)
          setMidiError(message)
          log(
            `MIDI access was refused: ${message}. Open site settings and allow MIDI, then press Connect again.`,
          )
        }
      } else {
        setMidiStatus('unsupported')
        log(
          'Web MIDI is missing here. Chrome or Edge on Android works, Firefox and iOS Safari do not.',
        )
      }

      let devices: AudioDeviceInfo[] = []
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
        probe.getTracks().forEach((t) => t.stop())
        const all = await navigator.mediaDevices.enumerateDevices()
        devices = all
          .filter((d) => d.kind === 'audioinput')
          .map((d) => ({
            deviceId: d.deviceId,
            label: d.label || `input ${d.deviceId.slice(0, 6)}`,
          }))
        setAudioDevices(devices)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        log(
          `Audio permission was refused, so nothing can be recorded: ${message}. Open site settings and allow microphone access, then press Connect again.`,
        )
        return
      }

      if (!devices.length) {
        log(
          'No audio input devices were found. Check the USB cable and that the OS sees the interface.',
        )
        return
      }
      const guess = devices.find((d) => HARDWARE_HINT.test(d.label))
      await openAudioDevice((guess ?? devices[0]).deviceId, preset)
    } finally {
      setConnecting(false)
    }
  }, [log, openAudioDevice, refreshMidiPorts, preset])

  useEffect(() => {
    setSecureContext(window.isSecureContext ? 'pass' : 'fail')

    let cancelled = false
    async function checkOpfs() {
      try {
        if (!navigator.storage?.getDirectory)
          throw new Error('navigator.storage.getDirectory is unavailable')
        const root = await navigator.storage.getDirectory()
        await root.getDirectoryHandle('diagnostics-check', { create: true })
        await root.removeEntry('diagnostics-check', { recursive: true }).catch(() => {})
        if (!cancelled) setOpfsStatus('pass')
      } catch (e) {
        if (!cancelled) {
          setOpfsStatus('fail')
          setOpfsError(e instanceof Error ? e.message : String(e))
        }
      }
    }
    async function checkWakeLock() {
      if (!('wakeLock' in navigator)) {
        if (!cancelled) setWakeLockStatus('fail')
        return
      }
      try {
        const lock = await navigator.wakeLock.request('screen')
        await lock.release()
        if (!cancelled) setWakeLockStatus('pass')
      } catch (e) {
        if (!cancelled) {
          setWakeLockStatus('fail')
          setWakeLockError(e instanceof Error ? e.message : String(e))
        }
      }
    }
    checkOpfs()
    checkWakeLock()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => closeAudioGraph, [closeAudioGraph])

  const buildReport = useCallback(() => {
    const lines: string[] = []
    lines.push('EP-REC hardware diagnostics report')
    lines.push(`generated: ${new Date().toISOString()}`)
    lines.push('')
    lines.push(`secure context: ${secureContext}`)
    lines.push(`OPFS: ${opfsStatus}${opfsError ? ` (${opfsError})` : ''}`)
    lines.push(`wake lock: ${wakeLockStatus}${wakeLockError ? ` (${wakeLockError})` : ''}`)
    lines.push('')
    lines.push(`MIDI: ${midiStatus}${midiError ? ` (${midiError})` : ''}`)
    if (midiPorts.length) {
      for (const p of midiPorts) lines.push(`  - ${p.name} / ${p.manufacturer} / ${p.state}`)
    } else {
      lines.push('  no ports')
    }
    lines.push('')
    lines.push(`audio devices (${audioDevices.length}):`)
    for (const d of audioDevices) lines.push(`  - ${d.label} [${d.deviceId}]`)
    lines.push('')
    if (trackDiag) {
      lines.push(`open device: ${trackDiag.deviceLabel}`)
      lines.push(`  preset: ${trackDiag.presetLabel}`)
      lines.push(`  sampleRate: ${trackDiag.sampleRate}`)
      lines.push(`  channelCount: ${trackDiag.channelCount}`)
      lines.push(`  echoCancellation off: ${!trackDiag.echoCancellation}`)
      lines.push(`  noiseSuppression off: ${!trackDiag.noiseSuppression}`)
      lines.push(`  autoGainControl off: ${!trackDiag.autoGainControl}`)
    } else {
      lines.push(`open device: none (${audioStatus}${audioError ? `: ${audioError}` : ''})`)
    }
    lines.push('')
    lines.push('messages:')
    for (const m of messages) lines.push(`  [${m.tone}] ${m.text}`)
    return lines.join('\n')
  }, [
    secureContext,
    opfsStatus,
    opfsError,
    wakeLockStatus,
    wakeLockError,
    midiStatus,
    midiError,
    midiPorts,
    audioDevices,
    trackDiag,
    audioStatus,
    audioError,
    messages,
  ])

  const copyReport = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(buildReport())
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    setTimeout(() => setCopyState('idle'), 2500)
  }, [buildReport])

  return (
    <div className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 bg-zinc-950 px-4 py-8 text-zinc-100">
      <header>
        <h1 className="text-xl font-bold tracking-tight">EP&ndash;REC hardware diagnostics</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Does this phone actually expose a USB audio interface to Chrome? Press Connect and read
          the answer below. Settings resolving correctly is not the same as audio actually arriving
          from the right device &mdash; watch the peak meter with real sound, not just the numbers
          above it. Confirmed on real hardware: forcing echo cancellation off breaks Android&apos;s
          device routing (it silently captures the phone mic instead), so the recommended preset
          leaves it at default. If the peak meter still stays flat on different hardware, try the
          other constraint presets under Audio input devices to re-diagnose.
        </p>
      </header>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => connect()}
          disabled={connecting}
          className="flex-1 rounded-md bg-orange-600 px-4 py-3 text-sm font-semibold uppercase tracking-wide text-white disabled:opacity-50"
        >
          {connecting ? 'Connecting…' : 'Connect'}
        </button>
        <button
          type="button"
          onClick={() => copyReport()}
          className="rounded-md border border-zinc-700 px-4 py-3 text-sm font-semibold uppercase tracking-wide text-zinc-200"
        >
          {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Failed' : 'Copy report'}
        </button>
      </div>

      {messages.length > 0 && (
        <div className="flex flex-col gap-2">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`rounded-md border px-3 py-2 text-sm ${
                m.tone === 'bad'
                  ? 'border-red-900 bg-red-950 text-red-200'
                  : 'border-zinc-700 bg-zinc-900 text-zinc-300'
              }`}
            >
              {m.text}
            </div>
          ))}
        </div>
      )}

      <section>
        <h2 className="mb-1 text-xs font-bold uppercase tracking-widest text-zinc-500">
          Environment
        </h2>
        <DiagLine
          label="secure context"
          status={secureContext}
          detail={
            secureContext === 'pass'
              ? 'https or localhost'
              : secureContext === 'fail'
                ? 'insecure'
                : '…'
          }
          hint="Serve this page over https, or from localhost during development."
        />
        <DiagLine
          label="OPFS storage"
          status={opfsStatus}
          detail={
            opfsStatus === 'pass'
              ? 'origin private fs available'
              : opfsStatus === 'fail'
                ? 'unavailable'
                : '…'
          }
          hint="Recordings will not persist across reloads. Use a current Chrome or Edge on Android."
        />
        <DiagLine
          label="wake lock"
          status={wakeLockStatus}
          detail={
            wakeLockStatus === 'pass'
              ? 'held and released cleanly'
              : wakeLockStatus === 'fail'
                ? 'unavailable'
                : '…'
          }
          hint="The screen may sleep mid-take. Disable auto-lock manually as a workaround."
        />
      </section>

      <section>
        <h2 className="mb-1 text-xs font-bold uppercase tracking-widest text-zinc-500">
          MIDI input ports
        </h2>
        <DiagLine
          label="web midi"
          status={midiStatus === 'granted' ? 'pass' : midiStatus === 'idle' ? 'unknown' : 'fail'}
          detail={
            midiStatus === 'granted'
              ? `${midiPorts.length} port${midiPorts.length === 1 ? '' : 's'}`
              : midiStatus === 'idle'
                ? 'press connect'
                : midiStatus
          }
          hint="Web MIDI needs Chrome or Edge on Android; Firefox and iOS Safari cannot see it."
        />
        {midiPorts.map((p) => (
          <div
            key={p.id}
            className="flex items-center gap-2 border-b border-zinc-800 py-2 text-sm last:border-0"
          >
            <span
              className={`h-2 w-2 rounded-full ${p.state === 'connected' ? 'bg-emerald-400' : 'bg-zinc-600'}`}
            />
            <span className="font-medium">{p.name}</span>
            <span className="text-zinc-500">{p.manufacturer}</span>
            <span className="ml-auto text-xs text-zinc-500">{p.state}</span>
          </div>
        ))}
      </section>

      <section>
        <h2 className="mb-1 text-xs font-bold uppercase tracking-widest text-zinc-500">
          Audio input devices
        </h2>
        {audioDevices.length > 0 && (
          <select
            value={selectedDeviceId}
            onChange={(e) => openAudioDevice(e.target.value, preset)}
            className="mb-2 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
          >
            {audioDevices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
        )}
        {audioDevices.length === 0 && (
          <p className="py-2 text-sm text-zinc-500">Press Connect to list devices.</p>
        )}
        {selectedDeviceId && (
          <div className="mt-2">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Constraint preset (re-opens the device above with each)
            </p>
            <div className="flex flex-wrap gap-2">
              {PRESET_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => openAudioDevice(selectedDeviceId, key)}
                  className={`rounded-md border px-3 py-2 text-xs font-semibold ${
                    preset === key
                      ? 'border-orange-600 bg-orange-950 text-orange-300'
                      : 'border-zinc-700 bg-zinc-900 text-zinc-300'
                  }`}
                >
                  {PRESETS[key].label}
                </button>
              ))}
            </div>
          </div>
        )}
        {audioDevices.map((d) => (
          <div
            key={d.deviceId}
            className="border-b border-zinc-800 py-1.5 text-xs text-zinc-500 last:border-0"
          >
            {d.label} <span className="text-zinc-600">[{d.deviceId.slice(0, 24)}]</span>
          </div>
        ))}
      </section>

      <section>
        <h2 className="mb-1 text-xs font-bold uppercase tracking-widest text-zinc-500">
          Resolved track settings
        </h2>
        {trackDiag ? (
          <>
            <DiagLine label="device" status="pass" detail={trackDiag.deviceLabel} />
            <DiagLine label="preset" status="pass" detail={trackDiag.presetLabel} />
            <DiagLine label="sample rate" status="pass" detail={`${trackDiag.sampleRate} Hz`} />
            <DiagLine label="channels" status="pass" detail={String(trackDiag.channelCount)} />
            <DiagLine
              label="echo cancellation"
              status="unknown"
              detail={trackDiag.echoCancellation ? 'on' : 'off'}
            />
            <p className="-mt-1 mb-2 text-xs text-zinc-500">
              Confirmed on real hardware: forcing this off breaks Android&apos;s device routing
              entirely (silently captures the phone mic instead), so the recommended preset leaves
              it at default rather than disabling it. There is no echo to cancel on a direct line-in
              signal, so this costs effectively nothing.
            </p>
            <DiagLine
              label="noise suppression"
              status={trackDiag.noiseSuppression ? 'fail' : 'pass'}
              detail={trackDiag.noiseSuppression ? 'ON (unwanted)' : 'off'}
              hint="The browser ignored the request to disable this. Signal may be processed."
            />
            <DiagLine
              label="auto gain control"
              status={trackDiag.autoGainControl ? 'fail' : 'pass'}
              detail={trackDiag.autoGainControl ? 'ON (unwanted)' : 'off'}
              hint="The browser ignored the request to disable this. Levels may be normalized."
            />
          </>
        ) : (
          <p className="py-2 text-sm text-zinc-500">
            {audioStatus === 'error' ? audioError : 'No input open yet.'}
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-1 text-xs font-bold uppercase tracking-widest text-zinc-500">
          Peak meter &amp; channel identity
        </h2>
        <div className="flex flex-col gap-2">
          {(['L', 'R'] as const).map((ch) => (
            <div key={ch} className="flex items-center gap-2">
              <span className="w-4 text-xs font-bold text-zinc-500">{ch}</span>
              <div className="h-3 flex-1 overflow-hidden rounded-sm bg-zinc-800">
                <div
                  ref={ch === 'L' ? barLRef : barRRef}
                  className="h-full w-0 bg-orange-600"
                  style={{ transition: 'width 40ms linear' }}
                />
              </div>
              <span
                ref={ch === 'L' ? readLRef : readRRef}
                className="w-12 text-right text-xs font-medium tabular-nums text-zinc-400"
              >
                0%
              </span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          Play something into the input. Bars should move; a steady 0% means samples are not
          arriving.
        </p>
        <p className="mt-3 text-xs text-zinc-500">
          <strong className="text-zinc-300">Channel identity test.</strong> The Sidekick presents
          four stereo pairs over USB (channel 1, channel 2, aux, main output), and Android only ever
          hands the browser the first pair &mdash; which one that is decides whether this app
          captures the finished mix or just whatever is plugged into channel one, and it is
          documented nowhere. Plug a source into Sidekick CH2 only, play it, and watch these same
          bars. <strong className="text-zinc-300">Signal</strong> means the first pair is the main
          mix and everything downstream is fine. <strong className="text-zinc-300">Silence</strong>{' '}
          means the first pair is CH1, and the rig has to be re-patched so the source that matters
          lands on channel one. This does not change between sessions on the same phone, so run it
          once and write the answer down.
        </p>
      </section>
    </div>
  )
}
