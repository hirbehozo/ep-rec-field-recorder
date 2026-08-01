import { interleave } from '../wav'
import type { WorkletMessage } from './types'

export interface PcmChunk {
  bytes: Uint8Array
  frames: number
}

export interface PcmSinkCallbacks {
  onPcm: (chunk: PcmChunk) => void
  onMeter?: (peakL: number, peakR: number) => void
}

/**
 * Gates incoming worklet messages by whether a writer or memory buffer is
 * open, not by whatever "recording" flag the UI shows. The worklet's final
 * partial buffer flushes asynchronously on stop and can arrive after the UI
 * has already flipped back to idle; dropping it loses the last fraction of
 * a second of every take.
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
    if (data.type === 'pcm' && this.open && this.callbacks) {
      const pcm = interleave(data.l, data.r, data.frames)
      this.callbacks.onPcm({ bytes: new Uint8Array(pcm.buffer), frames: data.frames })
    }
  }
}
