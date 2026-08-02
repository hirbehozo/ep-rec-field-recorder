import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { interleave } from '../wav'
import { convert24to16 } from './mp3'

interface LamejsModule {
  Mp3Encoder: new (
    channels: number,
    sampleRate: number,
    bitrateKbps: number,
  ) => {
    encodeBuffer: (left: Int16Array, right: Int16Array) => Int8Array
    flush: () => Int8Array
  }
}

/**
 * Loads the actual vendored public/lame.min.js the app ships, the same file
 * mp3-worker.js pulls in via importScripts. It's a plain script (`var
 * lamejs = ...`), so running it in a fresh vm context and reading the
 * context's `lamejs` global back out is the most direct way to exercise the
 * real encoder from a test, rather than trusting the file is well-formed.
 */
function loadLamejs(): LamejsModule {
  const code = readFileSync(path.join(process.cwd(), 'public/lame.min.js'), 'utf8')
  const sandbox: Record<string, unknown> = {}
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  return sandbox.lamejs as LamejsModule
}

const BITRATES_MPEG1_LAYER3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
const SAMPLE_RATES_MPEG1 = [44100, 48000, 32000, 0]

/** Minimal MPEG-1 Layer III frame walker, just enough to check what the encoder wrote. */
function parseMp3Frames(bytes: Uint8Array): { frameCount: number; durationSeconds: number } {
  let pos = 0
  let frameCount = 0
  let durationSeconds = 0
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] === 0xff && (bytes[pos + 1] & 0xe0) === 0xe0) {
      const b1 = bytes[pos + 1]
      const b2 = bytes[pos + 2]
      const versionBits = (b1 >> 3) & 0x3
      const layerBits = (b1 >> 1) & 0x3
      if (versionBits === 3 && layerBits === 1) {
        const bitrateIndex = (b2 >> 4) & 0xf
        const sampleRateIndex = (b2 >> 2) & 0x3
        const padding = (b2 >> 1) & 0x1
        const bitrate = BITRATES_MPEG1_LAYER3[bitrateIndex]
        const sampleRate = SAMPLE_RATES_MPEG1[sampleRateIndex]
        if (bitrate > 0 && sampleRate > 0) {
          const frameSize = Math.floor((144 * bitrate * 1000) / sampleRate) + padding
          if (frameSize > 0) {
            frameCount++
            durationSeconds += 1152 / sampleRate
            pos += frameSize
            continue
          }
        }
      }
    }
    pos++
  }
  return { frameCount, durationSeconds }
}

describe('MP3 pipeline, end to end against the real vendored encoder', () => {
  it('converts a 5 second signal to exactly 240000 frames, encodes within a few percent of the target bitrate, and parses back to the right duration', () => {
    const lamejs = loadLamejs()
    const sampleRate = 48000
    const seconds = 5
    const frames = sampleRate * seconds

    const l = new Float32Array(frames)
    const r = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      l[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sampleRate)
      r[i] = l[i]
    }

    // Run it through the exact same 24-bit interleave + 24-to-16 conversion
    // the real export pipeline uses, not a shortcut.
    const pcmBytes = interleave(l, r, frames)
    const { l: l16, r: r16 } = convert24to16(pcmBytes)
    expect(l16.length).toBe(240000)
    expect(r16.length).toBe(240000)

    const bitrate = 192
    const encoder = new lamejs.Mp3Encoder(2, sampleRate, bitrate)
    const chunks: Uint8Array[] = []
    for (let i = 0; i < l16.length; i += 1152) {
      const buf = encoder.encodeBuffer(l16.subarray(i, i + 1152), r16.subarray(i, i + 1152))
      if (buf.length) chunks.push(new Uint8Array(buf))
    }
    const tail = encoder.flush()
    if (tail.length) chunks.push(new Uint8Array(tail))

    const totalBytes = chunks.reduce((sum, c) => sum + c.length, 0)
    const expectedBytes = ((bitrate * 1000) / 8) * seconds
    const ratio = totalBytes / expectedBytes
    expect(ratio).toBeGreaterThan(0.9)
    expect(ratio).toBeLessThan(1.1)

    const all = new Uint8Array(totalBytes)
    let offset = 0
    for (const c of chunks) {
      all.set(c, offset)
      offset += c.length
    }

    const { frameCount, durationSeconds } = parseMp3Frames(all)
    expect(frameCount).toBeGreaterThan(0)
    expect(durationSeconds).toBeGreaterThan(seconds * 0.9)
    expect(durationSeconds).toBeLessThan(seconds * 1.1)
  })
})
