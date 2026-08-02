import { BYTES_PER_SAMPLE, interleave, wavHeader } from '../wav'

export interface SyncWritable {
  write(bytes: Uint8Array<ArrayBuffer>, position: number): void
  close(): void
}

export interface WriteSessionResult {
  frames: number
  writeErrors: number
}

/**
 * Position-tracking and header-rewrite logic for progressively writing a WAV
 * file to a synchronous handle, independent of where that handle actually
 * comes from — a real OPFS FileSystemSyncAccessHandle inside a worker, or a
 * fake for testing. A placeholder header goes in at construction, PCM
 * appends sequentially after it, and the real header overwrites position 0
 * once the final frame count is known.
 *
 * Never swallows a write error: a failed write does not advance position or
 * count toward frames, so the file stays internally consistent (just
 * shorter than the real take) and the failure is counted rather than
 * silently producing a gap nobody knows about.
 */
export class WriteSession {
  private position = 44
  private frames = 0
  private writeErrors = 0

  constructor(
    private readonly handle: SyncWritable,
    private readonly sampleRate: number,
    private readonly channels: number,
  ) {
    this.tryWrite(wavHeader(0, sampleRate, channels), 0)
  }

  private tryWrite(bytes: Uint8Array<ArrayBuffer>, position: number): boolean {
    try {
      this.handle.write(bytes, position)
      return true
    } catch {
      this.writeErrors++
      return false
    }
  }

  writeChunk(l: Float32Array, r: Float32Array, frames: number): void {
    const bytes = interleave(l, r, frames)
    if (this.tryWrite(bytes, this.position)) {
      this.position += bytes.byteLength
      this.frames += frames
    }
  }

  finish(): WriteSessionResult {
    const dataBytes = this.frames * this.channels * BYTES_PER_SAMPLE
    this.tryWrite(wavHeader(dataBytes, this.sampleRate, this.channels), 0)
    this.handle.close()
    return { frames: this.frames, writeErrors: this.writeErrors }
  }
}
