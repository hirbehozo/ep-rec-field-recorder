export interface WriterCloseResult {
  frames: number
  writeErrors: number
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

  open(fileHandle: FileSystemFileHandle, sampleRate: number, channels: number): Promise<void> {
    const worker = new Worker('/writer-worker.js')
    this.worker = worker
    return new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        if (e.data.type === 'opened') resolve()
        else if (e.data.type === 'openError') reject(new Error(e.data.message))
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
        if (e.data.type === 'closed') {
          resolve({ frames: e.data.frames, writeErrors: e.data.writeErrors })
          worker.terminate()
        }
      }
      worker.postMessage({ type: 'close' })
    })
  }
}
