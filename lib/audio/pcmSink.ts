import type { WorkletMessage } from './types'

export interface PcmChunk {
  l: Float32Array
  r: Float32Array
  frames: number
}

export interface PcmSinkCallbacks {
  onPcm: (chunk: PcmChunk) => void
  onMeter?: (peakL: number, peakR: number) => void
  onDiscontinuity?: (missingFrames: number, expectedFrames: number) => void
}

/**
 * Gates incoming worklet messages by whether a writer or memory buffer is
 * open, not by whatever "recording" flag the UI shows. The worklet's final
 * partial buffer flushes asynchronously on stop and can arrive after the UI
 * has already flipped back to idle; dropping it loses the last fraction of
 * a second of every take. PCM conversion itself does not happen here — raw
 * L/R buffers pass straight through, since where they go from here (a
 * dedicated writer worker, or an in-memory fallback) decides whether
 * conversion should happen off the main thread at all.
 */
export class PcmSink {
  private open = false
  private callbacks: PcmSinkCallbacks | null = null

  get isOpen(): boolean {
    return this.open
  }

  attach(callbacks: PcmSinkCallbacks): void {
    this.callbacks = callbacks
  }

  detach(): void {
    this.callbacks = null
  }

  setOpen(open: boolean): void {
    this.open = open
  }

  handleMessage(data: WorkletMessage): void {
    if (data.type === 'meter') {
      this.callbacks?.onMeter?.(data.pl, data.pr)
      return
    }
    if (data.type === 'discontinuity') {
      this.callbacks?.onDiscontinuity?.(data.missingFrames, data.expectedFrames)
      return
    }
    if (data.type === 'pcm' && this.open && this.callbacks) {
      this.callbacks.onPcm({ l: data.l, r: data.r, frames: data.frames })
    }
  }
}
