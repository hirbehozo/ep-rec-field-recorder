import { useCallback, useRef, useState } from 'react'
import { looksLikeHardware } from './deviceHint'
import { PcmSink, type PcmChunk } from './pcmSink'
import type { WorkletMessage } from './types'

export type RecorderStatus = 'idle' | 'opening' | 'ready' | 'recording' | 'error'

export interface RecorderState {
  status: RecorderStatus
  deviceLabel: string
  sampleRate: number
  channelCount: number
  peakL: number
  peakR: number
  clipped: boolean
  frames: number
  error: string | null
  deviceMessage: string | null
  // What the track itself reported at open, to compare against the
  // AudioContext's actual operating rate — a mismatch means the platform is
  // silently resampling.
  trackRate: number
  // Highest frequency carrying real signal, measured live; a full-range
  // source reading far below Nyquist means Android put the input on a
  // band-limited voice-communication path.
  bandwidth: number
  // Running |L-R| normalized magnitude from the worklet, updated only when
  // there's a nontrivial signal present; null until something's been played
  // through it. Near zero means the channels are identical, i.e. mono.
  monoRatio: number | null
  // Cumulative count of the worklet's buffer pool running dry.
  starve: number
}

// The worklet's final partial buffer flushes asynchronously after stop();
// this gives it time to land before the sink stops accepting PCM.
const STOP_DRAIN_MS = 220

interface AudioGraph {
  stream: MediaStream
  ctx: AudioContext
  source: MediaStreamAudioSourceNode
  node: AudioWorkletNode
  sink: GainNode
}

// ~40dB below the loudest bin, in the 0-255 byte scale getByteFrequencyData
// uses — the threshold a bin has to clear to count as "carrying signal"
// rather than noise floor.
const BANDWIDTH_FLOOR_BELOW_PEAK = 128
const BANDWIDTH_MIN_PEAK_BYTE = 40
const BANDWIDTH_GATE_LEVEL = 0.02
const MONO_RATIO_GATE_LEVEL = 0.01

const initialState: RecorderState = {
  status: 'idle',
  deviceLabel: '',
  sampleRate: 0,
  channelCount: 0,
  peakL: 0,
  peakR: 0,
  clipped: false,
  frames: 0,
  error: null,
  deviceMessage: null,
  trackRate: 0,
  bandwidth: 0,
  monoRatio: null,
  starve: 0,
}

export function useRecorder() {
  const [state, setState] = useState<RecorderState>(initialState)
  const graphRef = useRef<AudioGraph | null>(null)
  const pcmSinkRef = useRef(new PcmSink())
  const framesRef = useRef(0)
  const discontinuityRef = useRef({ missingFrames: 0, expectedFrames: 0 })
  const peakSessionRef = useRef(0)
  const recordingActiveRef = useRef(false)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const freqBinsRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const bandwidthRef = useRef(0)

  const close = useCallback(() => {
    const g = graphRef.current
    if (g) {
      g.stream.getTracks().forEach((t) => t.stop())
      g.ctx.close().catch(() => {})
      graphRef.current = null
    }
    analyserRef.current = null
    freqBinsRef.current = null
    bandwidthRef.current = 0
    pcmSinkRef.current.setOpen(false)
    pcmSinkRef.current.detach()
    setState((s) => ({
      ...s,
      status: 'idle',
      deviceLabel: '',
      sampleRate: 0,
      channelCount: 0,
      trackRate: 0,
      bandwidth: 0,
      monoRatio: null,
      starve: 0,
    }))
  }, [])

  // Live signal-quality readout, fed from every worklet meter message
  // regardless of recording state — this is what makes gain staging and
  // rig troubleshooting possible before ever pressing Record. peakSession
  // (used for the post-take "quiet take" warning) only accumulates while a
  // take is actually running.
  const handleMeter = useCallback((peakL: number, peakR: number, diff: number, starve: number) => {
    if (recordingActiveRef.current) {
      peakSessionRef.current = Math.max(peakSessionRef.current, peakL, peakR)
    }

    const analyser = analyserRef.current
    const freqBins = freqBinsRef.current
    if (analyser && freqBins && (peakL >= BANDWIDTH_GATE_LEVEL || peakR >= BANDWIDTH_GATE_LEVEL)) {
      analyser.getByteFrequencyData(freqBins)
      let peakBin = 0
      for (let i = 0; i < freqBins.length; i++) if (freqBins[i] > peakBin) peakBin = freqBins[i]
      if (peakBin >= BANDWIDTH_MIN_PEAK_BYTE) {
        const floor = peakBin - BANDWIDTH_FLOOR_BELOW_PEAK
        let top = 0
        for (let i = freqBins.length - 1; i > 0; i--) {
          if (freqBins[i] > floor) {
            top = i
            break
          }
        }
        const hz = (top * analyser.context.sampleRate) / analyser.fftSize
        if (hz > bandwidthRef.current) bandwidthRef.current = hz
      }
    }

    setState((s) => ({
      ...s,
      peakL,
      peakR,
      clipped: s.clipped || peakL >= 0.999 || peakR >= 0.999,
      bandwidth: bandwidthRef.current,
      monoRatio:
        peakL > MONO_RATIO_GATE_LEVEL || peakR > MONO_RATIO_GATE_LEVEL ? diff : s.monoRatio,
      starve: starve > s.starve ? starve : s.starve,
    }))
  }, [])

  const openDevice = useCallback(
    async (deviceId?: string) => {
      close()
      setState((s) => ({ ...s, status: 'opening', error: null, deviceMessage: null }))

      // echoCancellation is deliberately left unset (not forced to false):
      // explicitly disabling it broke Android's device routing entirely on
      // real hardware — getUserMedia would report the requested USB device
      // as open with matching settings while silently capturing the phone's
      // built-in mic instead. noiseSuppression/autoGainControl/voiceIsolation
      // can be disabled safely. For a direct line-in signal with no acoustic
      // loop between a speaker and a mic, echo cancellation has ~nothing to
      // do anyway, so leaving it at default costs effectively nothing.
      // voiceIsolation is Chrome-specific and not yet in TS's DOM lib.
      const baseConstraints: MediaTrackConstraints & { voiceIsolation?: boolean } = {
        noiseSuppression: false,
        autoGainControl: false,
        voiceIsolation: false,
        channelCount: { ideal: 2 },
      }
      if (deviceId) baseConstraints.deviceId = { exact: deviceId }

      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: baseConstraints })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        setState((s) => ({ ...s, status: 'error', error: message }))
        throw e
      }

      let track = stream.getAudioTracks()[0]
      let settings = track.getSettings()
      // The initial open above doesn't ask for a rate, so the platform
      // picks its own default (often 48kHz) even when the interface's
      // converters run higher. getCapabilities() reports what the device
      // can actually do; if that ceiling is above what we got, reopen once
      // asking for it — an "ideal" constraint, not "exact", since a device
      // that can't hit it precisely should still open rather than fail.
      const maxRate = track.getCapabilities?.().sampleRate?.max
      if (maxRate && maxRate > (settings.sampleRate ?? 0)) {
        // Pin to the exact device the first open resolved to (relevant when
        // the caller didn't pass a deviceId at all), so the reopen can't
        // land on a different physical device than the one just measured.
        const resolvedDeviceId = settings.deviceId
        stream.getTracks().forEach((t) => t.stop())
        const highRateConstraints: MediaTrackConstraints = {
          ...baseConstraints,
          sampleRate: { ideal: maxRate },
        }
        if (resolvedDeviceId) highRateConstraints.deviceId = { exact: resolvedDeviceId }
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: highRateConstraints })
          track = stream.getAudioTracks()[0]
          settings = track.getSettings()
        } catch {
          // Fall back to the original constraints rather than leaving the
          // device unopened over a rate that turned out unreachable.
          const fallbackConstraints: MediaTrackConstraints = { ...baseConstraints }
          if (resolvedDeviceId) fallbackConstraints.deviceId = { exact: resolvedDeviceId }
          stream = await navigator.mediaDevices.getUserMedia({ audio: fallbackConstraints })
          track = stream.getAudioTracks()[0]
          settings = track.getSettings()
        }
      }

      // Tells the platform this is music, not a voice call, where honored.
      // Not guaranteed, but costs nothing to ask.
      try {
        track.contentHint = 'music'
      } catch {
        // not supported on this browser, fine to ignore
      }
      track.onended = () => {
        setState((s) => ({
          ...s,
          deviceMessage: 'The audio input disappeared. Check the USB cable, then scan again.',
        }))
        close()
      }

      // 'playback' asks for larger buffers. We're recording, not
      // monitoring, so latency costs nothing and underruns cost everything.
      let ctx: AudioContext
      try {
        ctx = settings.sampleRate
          ? new AudioContext({ sampleRate: settings.sampleRate, latencyHint: 'playback' })
          : new AudioContext({ latencyHint: 'playback' })
      } catch {
        ctx = new AudioContext()
      }
      await ctx.resume()
      await ctx.audioWorklet.addModule('/rec-worklet.js')

      const source = ctx.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(ctx, 'rec', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
      })
      node.port.onmessage = (e: MessageEvent<WorkletMessage>) =>
        pcmSinkRef.current.handleMessage(e.data)
      // The live signal-quality readout needs to work before a take ever
      // starts, so the meter handler is attached here, at device-open, not
      // inside start(). start()/stop() only re-attach to add/remove the
      // take-specific pcm/discontinuity handlers, always alongside the same
      // handleMeter.
      pcmSinkRef.current.attach({
        onPcm: () => {},
        onMeter: handleMeter,
        onDiscontinuity: () => {},
      })
      source.connect(node)
      // The node must reach destination through a zero gain node, or
      // process() never runs — an unreachable node gets skipped by the
      // audio engine's pull-based scheduling.
      const sink = ctx.createGain()
      sink.gain.value = 0
      node.connect(sink)
      sink.connect(ctx.destination)

      // Measures what the platform actually delivered, rather than what it
      // claimed — a passive tap on source, which is already being pulled
      // via the worklet's path to destination, so this needs no output
      // connection of its own.
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = 0
      analyser.minDecibels = -90
      analyser.maxDecibels = -10
      source.connect(analyser)
      analyserRef.current = analyser
      freqBinsRef.current = new Uint8Array(analyser.frequencyBinCount)
      bandwidthRef.current = 0

      graphRef.current = { stream, ctx, source, node, sink }
      const deviceLabel = track.label || 'unnamed input'
      setState((s) => ({
        ...s,
        status: 'ready',
        deviceLabel,
        sampleRate: ctx.sampleRate,
        channelCount: settings.channelCount ?? 2,
        trackRate: settings.sampleRate || 0,
        bandwidth: 0,
        monoRatio: null,
        starve: 0,
        deviceMessage: looksLikeHardware(deviceLabel)
          ? null
          : 'That input looks like the phone microphone rather than the Sidekick. Pick the USB device from the list.',
      }))
    },
    [close, handleMeter],
  )

  // Hands a chunk's buffers back to the worklet's pool once the caller is
  // done with them (converted to bytes, or written), so the worklet never
  // has to allocate mid-recording to keep up.
  const recycleBuffers = useCallback((l: Float32Array, r: Float32Array) => {
    graphRef.current?.node.port.postMessage({ type: 'recycle', l, r }, [l.buffer, r.buffer])
  }, [])

  const start = useCallback(
    (onPcm: (chunk: PcmChunk) => void) => {
      const g = graphRef.current
      if (!g) return
      framesRef.current = 0
      discontinuityRef.current = { missingFrames: 0, expectedFrames: 0 }
      peakSessionRef.current = 0
      recordingActiveRef.current = true
      pcmSinkRef.current.attach({
        onPcm: (chunk) => {
          framesRef.current += chunk.frames
          setState((s) => ({ ...s, frames: framesRef.current }))
          onPcm(chunk)
        },
        onMeter: handleMeter,
        onDiscontinuity: (missingFrames, expectedFrames) => {
          discontinuityRef.current = { missingFrames, expectedFrames }
        },
      })
      pcmSinkRef.current.setOpen(true)
      g.node.port.postMessage({ on: true })
      setState((s) => ({ ...s, status: 'recording', frames: 0, clipped: false }))
    },
    [handleMeter],
  )

  const stop = useCallback(async (): Promise<
    { frames: number; missingFrames: number; peakSession: number } | undefined
  > => {
    const g = graphRef.current
    if (!g) return undefined
    g.node.port.postMessage({ on: false })
    // The UI-facing status can flip immediately; the sink itself must stay
    // open a little longer for the worklet's async final flush.
    setState((s) => (s.status === 'recording' ? { ...s, status: 'ready' } : s))
    await new Promise((resolve) => setTimeout(resolve, STOP_DRAIN_MS))
    pcmSinkRef.current.setOpen(false)
    recordingActiveRef.current = false
    // Re-attach the meter-only baseline rather than detaching outright, so
    // the live signal-quality readout keeps working between takes while the
    // device stays open.
    pcmSinkRef.current.attach({ onPcm: () => {}, onMeter: handleMeter, onDiscontinuity: () => {} })
    // framesRef/discontinuityRef/peakSessionRef are updated synchronously
    // inside the sink callbacks as messages arrive, so by the time the
    // drain wait above resolves they already reflect the final flush and
    // the worklet's own discontinuity report (both part of the same
    // on:false handling in the worklet) — safe to read without racing the
    // batched, async state.
    return {
      frames: framesRef.current,
      missingFrames: discontinuityRef.current.missingFrames,
      peakSession: peakSessionRef.current,
    }
  }, [handleMeter])

  return { ...state, openDevice, close, start, stop, recycleBuffers }
}
