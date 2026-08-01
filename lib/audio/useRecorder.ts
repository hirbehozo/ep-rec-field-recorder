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
}

export function useRecorder() {
  const [state, setState] = useState<RecorderState>(initialState)
  const graphRef = useRef<AudioGraph | null>(null)
  const pcmSinkRef = useRef(new PcmSink())
  const framesRef = useRef(0)

  const close = useCallback(() => {
    const g = graphRef.current
    if (g) {
      g.stream.getTracks().forEach((t) => t.stop())
      g.ctx.close().catch(() => {})
      graphRef.current = null
    }
    pcmSinkRef.current.setOpen(false)
    pcmSinkRef.current.detach()
    setState((s) => ({ ...s, status: 'idle', deviceLabel: '', sampleRate: 0, channelCount: 0 }))
  }, [])

  const openDevice = useCallback(
    async (deviceId?: string) => {
      close()
      setState((s) => ({ ...s, status: 'opening', error: null, deviceMessage: null }))

      // echoCancellation is deliberately left unset (not forced to false):
      // explicitly disabling it broke Android's device routing entirely on
      // real hardware — getUserMedia would report the requested USB device
      // as open with matching settings while silently capturing the phone's
      // built-in mic instead. noiseSuppression/autoGainControl can be
      // disabled safely. For a direct line-in signal with no acoustic loop
      // between a speaker and a mic, echo cancellation has ~nothing to do
      // anyway, so this costs effectively nothing.
      const constraints: MediaTrackConstraints = {
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 },
      }
      if (deviceId) constraints.deviceId = { exact: deviceId }

      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: constraints })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        setState((s) => ({ ...s, status: 'error', error: message }))
        throw e
      }

      const track = stream.getAudioTracks()[0]
      const settings = track.getSettings()
      track.onended = () => {
        setState((s) => ({
          ...s,
          deviceMessage: 'The audio input disappeared. Check the USB cable, then scan again.',
        }))
        close()
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
      source.connect(node)
      // The node must reach destination through a zero gain node, or
      // process() never runs — an unreachable node gets skipped by the
      // audio engine's pull-based scheduling.
      const sink = ctx.createGain()
      sink.gain.value = 0
      node.connect(sink)
      sink.connect(ctx.destination)

      graphRef.current = { stream, ctx, source, node, sink }
      const deviceLabel = track.label || 'unnamed input'
      setState((s) => ({
        ...s,
        status: 'ready',
        deviceLabel,
        sampleRate: ctx.sampleRate,
        channelCount: settings.channelCount ?? 2,
        deviceMessage: looksLikeHardware(deviceLabel)
          ? null
          : 'That input looks like the phone microphone rather than the Sidekick. Pick the USB device from the list.',
      }))
    },
    [close],
  )

  const start = useCallback((onPcm: (chunk: PcmChunk) => void) => {
    const g = graphRef.current
    if (!g) return
    framesRef.current = 0
    pcmSinkRef.current.attach({
      onPcm: (chunk) => {
        framesRef.current += chunk.frames
        setState((s) => ({ ...s, frames: framesRef.current }))
        onPcm(chunk)
      },
      onMeter: (peakL, peakR) => {
        setState((s) => ({
          ...s,
          peakL,
          peakR,
          clipped: s.clipped || peakL >= 0.999 || peakR >= 0.999,
        }))
      },
    })
    pcmSinkRef.current.setOpen(true)
    g.node.port.postMessage({ on: true })
    setState((s) => ({ ...s, status: 'recording', frames: 0, clipped: false }))
  }, [])

  const stop = useCallback(async (): Promise<{ frames: number } | undefined> => {
    const g = graphRef.current
    if (!g) return undefined
    g.node.port.postMessage({ on: false })
    // The UI-facing status can flip immediately; the sink itself must stay
    // open a little longer for the worklet's async final flush.
    setState((s) => (s.status === 'recording' ? { ...s, status: 'ready' } : s))
    await new Promise((resolve) => setTimeout(resolve, STOP_DRAIN_MS))
    pcmSinkRef.current.setOpen(false)
    pcmSinkRef.current.detach()
    // framesRef is updated synchronously inside the onPcm wrapper as chunks
    // arrive, so by the time the drain wait above resolves it already
    // reflects the final flushed chunk — safe to read without racing the
    // (batched, async) `frames` state.
    return { frames: framesRef.current }
  }, [])

  return { ...state, openDevice, close, start, stop }
}
