import { PcmSink } from './pcmSink'
import type { PcmMessage } from './types'

function pcmMessage(frames: number, value = 0.5): PcmMessage {
  return {
    type: 'pcm',
    l: new Float32Array(frames).fill(value),
    r: new Float32Array(frames).fill(value),
    frames,
  }
}

describe('PcmSink', () => {
  it('delivers pcm chunks while open', () => {
    const sink = new PcmSink()
    const received: number[] = []
    sink.attach({ onPcm: (chunk) => received.push(chunk.frames) })
    sink.setOpen(true)
    sink.handleMessage(pcmMessage(100))
    expect(received).toEqual([100])
  })

  it('drops pcm chunks while closed', () => {
    const sink = new PcmSink()
    const received: number[] = []
    sink.attach({ onPcm: (chunk) => received.push(chunk.frames) })
    sink.handleMessage(pcmMessage(100)) // never opened
    expect(received).toEqual([])
  })

  it('retains the worklet final flush that arrives after the UI has already moved on', () => {
    // Reproduces the exact prototype bug: stop() can flip the UI-facing
    // recording flag immediately, but the worklet's final partial buffer
    // flushes asynchronously and arrives afterward. The sink must gate on
    // its own open/closed state, not on that flag, or the tail is lost.
    const sink = new PcmSink()
    const received: number[] = []
    sink.attach({ onPcm: (chunk) => received.push(chunk.frames) })
    sink.setOpen(true)
    sink.handleMessage(pcmMessage(8192)) // a full chunk mid-take

    // "recording" flips to false here in the real hook, but the sink is
    // deliberately left open until the async flush has had time to land.
    const finalChunkFrames = 311
    sink.handleMessage(pcmMessage(finalChunkFrames))
    expect(received).toEqual([8192, finalChunkFrames])

    // only once the drain window has actually elapsed does the caller close it
    sink.setOpen(false)
    sink.handleMessage(pcmMessage(50))
    expect(received).toEqual([8192, finalChunkFrames]) // nothing more accepted
  })

  it('forwards meter messages regardless of open state', () => {
    const sink = new PcmSink()
    const meters: Array<[number, number]> = []
    sink.attach({ onPcm: () => {}, onMeter: (l, r) => meters.push([l, r]) })
    sink.handleMessage({ type: 'meter', pl: 0.4, pr: 0.6 })
    expect(meters).toEqual([[0.4, 0.6]])
  })

  it('interleaves L/R into ready-to-write bytes', () => {
    const sink = new PcmSink()
    let bytes: Uint8Array | null = null
    sink.attach({
      onPcm: (chunk) => {
        bytes = chunk.bytes
      },
    })
    sink.setOpen(true)
    sink.handleMessage({
      type: 'pcm',
      l: new Float32Array([0.5]),
      r: new Float32Array([-0.5]),
      frames: 1,
    })
    expect(bytes).not.toBeNull()
    const view = new DataView((bytes as unknown as Uint8Array).buffer)
    expect(view.getInt16(0, true)).toBe(Math.trunc(0.5 * 0x7fff))
    expect(view.getInt16(2, true)).toBe(Math.trunc(-0.5 * 0x8000))
  })
})
