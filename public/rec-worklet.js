const CHUNK = 8192

class Rec extends AudioWorkletProcessor {
  constructor() {
    super()
    this.on = false
    this.l = new Float32Array(CHUNK)
    this.r = new Float32Array(CHUNK)
    this.n = 0
    this.blocks = 0
    this.pl = 0
    this.pr = 0
    this.port.onmessage = (e) => {
      if (e.data.on !== undefined) {
        this.on = e.data.on
        if (!this.on) this.flush()
        this.n = 0
      }
    }
  }

  flush() {
    if (this.n === 0) return
    const l = this.l.slice(0, this.n)
    const r = this.r.slice(0, this.n)
    this.port.postMessage({ type: 'pcm', l, r, frames: this.n }, [l.buffer, r.buffer])
    this.n = 0
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
    }
    if (this.on) {
      for (let i = 0; i < L.length; i++) {
        this.l[this.n] = L[i]
        this.r[this.n] = R[i]
        this.n++
        if (this.n === CHUNK) this.flush()
      }
    }
    this.blocks++
    if (this.blocks % 8 === 0) {
      this.port.postMessage({ type: 'meter', pl: this.pl, pr: this.pr })
      this.pl = 0
      this.pr = 0
    }
    return true
  }
}

registerProcessor('rec', Rec)
