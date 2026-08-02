import { wavHeader } from '../wav'
import { WriteSession, type SyncWritable } from './writeSession'

interface Call {
  bytes: Uint8Array
  position: number
}

class FakeHandle implements SyncWritable {
  calls: Call[] = []
  closed = false
  failAt: number[] = [] // call indices (0-based) that should throw

  write(bytes: Uint8Array<ArrayBuffer>, position: number): void {
    const index = this.calls.length
    this.calls.push({ bytes: bytes.slice(), position })
    if (this.failAt.includes(index)) throw new Error('simulated write failure')
  }

  close(): void {
    this.closed = true
  }
}

function sine(frames: number, amplitude = 0.5): { l: Float32Array; r: Float32Array } {
  const l = new Float32Array(frames)
  const r = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    l[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / 48000)
    r[i] = l[i]
  }
  return { l, r }
}

describe('WriteSession', () => {
  it('writes a placeholder header at position 0 on construction', () => {
    const handle = new FakeHandle()
    new WriteSession(handle, 48000, 2)
    expect(handle.calls).toHaveLength(1)
    expect(handle.calls[0].position).toBe(0)
    expect(handle.calls[0].bytes).toEqual(wavHeader(0, 48000, 2))
  })

  it('appends chunks sequentially after the header', () => {
    const handle = new FakeHandle()
    const session = new WriteSession(handle, 48000, 2)
    const { l, r } = sine(10)
    session.writeChunk(l, r, 10)
    session.writeChunk(l, r, 10)

    expect(handle.calls).toHaveLength(3) // header + 2 chunks
    expect(handle.calls[1].position).toBe(44)
    const chunkBytes = 10 * 2 * 3 // frames * channels * 24-bit bytes
    expect(handle.calls[2].position).toBe(44 + chunkBytes)
  })

  it('rewrites the real header at position 0 on finish, after all chunk data', () => {
    const handle = new FakeHandle()
    const session = new WriteSession(handle, 48000, 2)
    const { l, r } = sine(100)
    session.writeChunk(l, r, 100)
    const result = session.finish()

    expect(result.frames).toBe(100)
    expect(result.writeErrors).toBe(0)
    expect(handle.closed).toBe(true)

    const finalHeaderCall = handle.calls[handle.calls.length - 1]
    expect(finalHeaderCall.position).toBe(0)
    expect(finalHeaderCall.bytes).toEqual(wavHeader(100 * 2 * 3, 48000, 2))
  })

  it('counts a failed chunk write as an error without advancing position or frames', () => {
    const handle = new FakeHandle()
    handle.failAt = [1] // the first chunk write (call index 1, after the header)
    const session = new WriteSession(handle, 48000, 2)
    const { l, r } = sine(10)

    session.writeChunk(l, r, 10) // fails
    session.writeChunk(l, r, 10) // succeeds, should land right after the header

    const result = session.finish()
    expect(result.writeErrors).toBe(1)
    expect(result.frames).toBe(10) // only the successful chunk counted

    // the successful chunk was written at position 44, not after a phantom failed one
    const successfulChunkCall = handle.calls.find((c) => c.position === 44 && c.bytes.length > 44)
    expect(successfulChunkCall).toBeDefined()
  })

  it('counts a failed final header rewrite without throwing', () => {
    const handle = new FakeHandle()
    // header write (index 0) and the final rewrite (index 2, after one chunk write at index 1) both fail
    handle.failAt = [0, 2]
    const session = new WriteSession(handle, 48000, 2)
    const { l, r } = sine(5)
    session.writeChunk(l, r, 5)
    const result = session.finish()
    expect(result.writeErrors).toBe(2)
    expect(handle.closed).toBe(true)
  })
})
