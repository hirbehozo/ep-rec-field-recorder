const CHUNK = 8192
const POOL = 6

class Rec extends AudioWorkletProcessor {
  constructor() {
    super()
    this.on = false
    // Nothing in here may allocate once running. Allocation and the
    // garbage collection that follows happen on the audio rendering thread,
    // and that is what crackle sounds like. Buffers are handed to the main
    // thread by transfer and handed straight back when it's done with them.
    this.free = []
    for (let i = 0; i < POOL; i++) {
      this.free.push({ l: new Float32Array(CHUNK), r: new Float32Array(CHUNK) })
    }
    this.cur = this.free.pop()
    this.n = 0
    this.blocks = 0
    this.pl = 0
    this.pr = 0
    this.dsum = 0 // running |L-R|, for mono detection
    this.tsum = 0 // running L+R magnitude, normalizes dsum
    this.starve = 0 // pool ran dry and had to allocate; the main thread fell behind
    this.framesWhileOn = 0
    this.recordStartTime = 0
    this.port.onmessage = (e) => {
      const m = e.data
      if (m.type === 'recycle') {
        this.free.push({ l: m.l, r: m.r })
        return
      }
      if (m.on !== undefined) {
        const turningOn = m.on && !this.on
        this.on = m.on
        if (turningOn) {
          this.recordStartTime = currentTime
          this.framesWhileOn = 0
        }
        if (!this.on) {
          this.flush()
          this.reportDiscontinuity()
        }
        this.n = 0
      }
    }
  }

  take() {
    const b = this.free.pop()
    if (b) return b
    this.starve++
    return { l: new Float32Array(CHUNK), r: new Float32Array(CHUNK) }
  }

  flush() {
    if (this.n === 0) return
    // Swap in the next buffer before posting, since flush() can be called
    // mid-loop from process() and any cached reference to the old buffer
    // would otherwise go stale the instant it's transferred away.
    const b = this.cur
    const n = this.n
    this.cur = this.take()
    this.n = 0
    this.port.postMessage({ type: 'pcm', l: b.l, r: b.r, frames: n }, [b.l.buffer, b.r.buffer])
  }

  // Compares frames actually captured against what the audio clock says
  // should have arrived, so a dropped render quantum shows up as a
  // recorded fact rather than a silently shortened take.
  reportDiscontinuity() {
    const elapsed = currentTime - this.recordStartTime
    const expectedFrames = Math.round(elapsed * sampleRate)
    const missingFrames = Math.max(0, expectedFrames - this.framesWhileOn)
    this.port.postMessage({ type: 'discontinuity', missingFrames, expectedFrames })
  }

  process(inputs) {
    const inp = inputs[0]
    if (!inp || inp.length === 0) return true
    const L = inp[0]
    const R = inp.length > 1 ? inp[1] : inp[0]
    if (!L) return true
    for (let i = 0; i < L.length; i++) {
      const a = L[i] < 0 ? -L[i] : L[i]
      const b = R[i] < 0 ? -R[i] : R[i]
      if (a > this.pl) this.pl = a
      if (b > this.pr) this.pr = b
      const d = L[i] - R[i]
      this.dsum += d < 0 ? -d : d
      this.tsum += a + b
    }
    if (this.on) {
      // Copy in runs bounded by how much room is left in the current
      // buffer, re-reading this.cur.l/r after every flush() swap.
      let i = 0
      while (i < L.length) {
        const cl = this.cur.l
        const cr = this.cur.r
        const room = CHUNK - this.n
        const run = Math.min(room, L.length - i)
        for (let k = 0; k < run; k++) {
          cl[this.n + k] = L[i + k]
          cr[this.n + k] = R[i + k]
        }
        this.n += run
        i += run
        if (this.n === CHUNK) this.flush()
      }
      this.framesWhileOn += L.length
    }
    this.blocks++
    if (this.blocks % 8 === 0) {
      this.port.postMessage({
        type: 'meter',
        pl: this.pl,
        pr: this.pr,
        diff: this.tsum > 0 ? this.dsum / this.tsum : 0,
        starve: this.starve,
      })
      this.pl = 0
      this.pr = 0
      this.dsum = 0
      this.tsum = 0
    }
    return true
  }
}

registerProcessor('rec', Rec)
