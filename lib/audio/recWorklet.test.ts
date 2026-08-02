import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const QUANTUM = 128 // real AudioWorklet render quantum size
const CHUNK = 8192

class FakePort {
  sent: Array<Record<string, unknown>> = []
  onmessage: ((e: { data: Record<string, unknown> }) => void) | null = null
  postMessage(msg: Record<string, unknown>): void {
    this.sent.push(msg)
  }
  receive(data: Record<string, unknown>): void {
    this.onmessage?.({ data })
  }
}

interface RecInstance {
  port: FakePort
  process(inputs: Float32Array[][]): boolean
}

/**
 * Loads the actual public/rec-worklet.js the app ships (the same file
 * AudioWorklet loads via addModule), stubbing just enough of the
 * AudioWorkletGlobalScope (AudioWorkletProcessor, registerProcessor,
 * currentTime, sampleRate) to run it for real in Node, rather than trusting
 * a from-scratch reimplementation of its buffer-pool logic.
 */
function loadRecProcessor(): new () => RecInstance {
  const code = readFileSync(path.join(process.cwd(), 'public/rec-worklet.js'), 'utf8')
  const captured: { cls?: new () => RecInstance } = {}
  const sandbox = {
    currentTime: 0,
    sampleRate: 48000,
    AudioWorkletProcessor: class {
      port = new FakePort()
    },
    registerProcessor: (_name: string, cls: new () => RecInstance) => {
      captured.cls = cls
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  if (!captured.cls) throw new Error('registerProcessor was never called')
  return captured.cls
}

function quantum(fill: (i: number) => number): Float32Array[][] {
  const l = new Float32Array(QUANTUM)
  const r = new Float32Array(QUANTUM)
  for (let i = 0; i < QUANTUM; i++) {
    const v = fill(i)
    l[i] = v
    r[i] = v
  }
  return [[l, r]]
}

describe('rec-worklet.js buffer pool', () => {
  it('feeds a counting ramp through several hundred render quanta with every frame arriving exactly once, unbroken across chunk boundaries', () => {
    const Rec = loadRecProcessor()
    const rec = new Rec()
    const port = rec.port as unknown as FakePort
    port.receive({ on: true })

    let counter = 0
    const QUANTA = 400 // several hundred, spanning many 8192-frame chunk flushes
    const chunks: { l: Float32Array; frames: number }[] = []
    for (let q = 0; q < QUANTA; q++) {
      rec.process(quantum(() => counter++))
      // recycle every transferred buffer immediately, as the main thread does
      for (const msg of port.sent.splice(0)) {
        if (msg.type === 'pcm') {
          // Copy out before recycling: real postMessage transfer hands the
          // receiver a distinct object, but this in-process fake shares
          // references, so recycling the original would let a later
          // process() call overwrite data this test still needs to read.
          chunks.push({ l: (msg.l as Float32Array).slice(), frames: msg.frames as number })
          port.receive({ type: 'recycle', l: msg.l, r: msg.r })
        }
      }
    }
    port.receive({ on: false })
    for (const msg of port.sent.splice(0)) {
      if (msg.type === 'pcm')
        chunks.push({ l: msg.l as Float32Array, frames: msg.frames as number })
    }

    const reassembled: number[] = []
    for (const c of chunks) {
      for (let i = 0; i < c.frames; i++) reassembled.push(c.l[i])
    }
    expect(reassembled.length).toBe(QUANTA * QUANTUM)
    for (let i = 0; i < reassembled.length; i++) expect(reassembled[i]).toBe(i)
  })

  it('counts pool starvation when buffers are never recycled, and keeps recording anyway', () => {
    const Rec = loadRecProcessor()
    const rec = new Rec()
    const port = rec.port as unknown as FakePort
    port.receive({ on: true })

    // POOL is 6, so flushing 8 full chunks without ever recycling exhausts
    // the pool starting on the 7th flush (6 pre-allocated + 1 already `cur`).
    for (let c = 0; c < 8; c++) {
      for (let q = 0; q < CHUNK / QUANTUM; q++) {
        rec.process(quantum(() => 0.1))
      }
    }
    const meter = [...port.sent].reverse().find((m) => m.type === 'meter')
    expect(meter?.starve).toBeGreaterThan(0)

    const pcmCount = port.sent.filter((m) => m.type === 'pcm').length
    expect(pcmCount).toBe(8) // starvation still allocates a fallback rather than dropping the chunk
  })

  it('reports near-zero diff for identical L/R (mono-like) and a large diff for inverted channels', () => {
    const RecA = loadRecProcessor()
    const recA = new RecA()
    const portA = recA.port as unknown as FakePort
    for (let q = 0; q < 8; q++) recA.process(quantum((i) => Math.sin(i)))
    const meterA = portA.sent.find((m) => m.type === 'meter')
    expect(meterA?.diff).toBeCloseTo(0, 5)

    const RecB = loadRecProcessor()
    const recB = new RecB()
    const portB = recB.port as unknown as FakePort
    const l = new Float32Array(QUANTUM)
    const r = new Float32Array(QUANTUM)
    for (let i = 0; i < QUANTUM; i++) {
      l[i] = 0.5
      r[i] = -0.5
    }
    for (let q = 0; q < 8; q++) recB.process([[l, r]])
    const meterB = portB.sent.find((m) => m.type === 'meter')
    expect(meterB?.diff).toBeCloseTo(1, 5)
  })
})
