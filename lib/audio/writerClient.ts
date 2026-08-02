export interface WriterCloseResult {
  frames: number
  writeErrors: number
}

export interface WriterClientCallbacks {
  // The worker is done with a chunk's buffers (interleave() already copied
  // what it needed) and hands them back so the worklet's buffer pool never
  // has to allocate to keep up.
  onRecycle?: (l: Float32Array, r: Float32Array) => void
  // Fires on every failed write, not just the total at close, so a live
  // "dropouts" reading doesn't have to wait for the take to end.
  onWriteError?: (count: number) => void
}

/**
 * Main-thread facade for the OPFS writer worker (public/writer-worker.js).
 * PCM conversion and the actual file write happen off the main thread via
 * createSyncAccessHandle, which is worker-only and substantially faster
 * than a main-thread createWritable stream, so a slow render can never
 * stall a disk write. Loaded as a real static file rather than bundled —
 * Next's build does not reliably turn `new Worker(new URL(...))` into a
 * real worker chunk, the same reasoning that keeps rec-worklet.js a plain
 * public file instead of a blob URL.
 */
export class WriterClient {
  private worker: Worker | null = null
  private callbacks: WriterClientCallbacks = {}

  open(
    fileHandle: FileSystemFileHandle,
    sampleRate: number,
    channels: number,
    callbacks: WriterClientCallbacks = {},
  ): Promise<void> {
    const worker = new Worker('/writer-worker.js')
    this.worker = worker
    this.callbacks = callbacks
    return new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        const data = e.data
        if (data.type === 'opened') resolve()
        else if (data.type === 'openError') reject(new Error(data.message))
        else if (data.type === 'recycle') this.callbacks.onRecycle?.(data.l, data.r)
        else if (data.type === 'writeError') this.callbacks.onWriteError?.(data.count)
      }
      worker.onerror = (e) => reject(new Error(e.message))
      worker.postMessage({ type: 'open', fileHandle, sampleRate, channels })
    })
  }

  writeChunk(l: Float32Array, r: Float32Array, frames: number): void {
    this.worker?.postMessage({ type: 'pcm', l, r, frames }, [l.buffer, r.buffer])
  }

  close(): Promise<WriterCloseResult> {
    const worker = this.worker
    this.worker = null
    if (!worker) return Promise.resolve({ frames: 0, writeErrors: 0 })
    return new Promise((resolve) => {
      worker.onmessage = (e) => {
        const data = e.data
        if (data.type === 'recycle') {
          this.callbacks.onRecycle?.(data.l, data.r)
          return
        }
        if (data.type === 'writeError') {
          this.callbacks.onWriteError?.(data.count)
          return
        }
        if (data.type === 'closed') {
          resolve({ frames: data.frames, writeErrors: data.writeErrors })
          worker.terminate()
        }
      }
      worker.postMessage({ type: 'close' })
    })
  }
}
