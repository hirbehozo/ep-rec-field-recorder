// MP3 encoding runs here so a long take never blocks the panel. The main
// thread streams the stored 24-bit WAV in blocks and waits for each
// acknowledgement before sending the next, which bounds memory to one block.
importScripts('./lame.min.js')

let enc = null
let out = []

self.onmessage = (e) => {
  const m = e.data

  if (m.type === 'init') {
    enc = new lamejs.Mp3Encoder(2, m.sampleRate, m.bitrate)
    out = []
    self.postMessage({ type: 'ready' })
    return
  }

  if (m.type === 'chunk') {
    for (let i = 0; i < m.l.length; i += 1152) {
      const buf = enc.encodeBuffer(m.l.subarray(i, i + 1152), m.r.subarray(i, i + 1152))
      if (buf.length) out.push(new Uint8Array(buf))
    }
    self.postMessage({ type: 'progress', done: m.done })
    return
  }

  if (m.type === 'end') {
    const tail = enc.flush()
    if (tail.length) out.push(new Uint8Array(tail))
    self.postMessage({ type: 'done', blob: new Blob(out, { type: 'audio/mpeg' }) })
    enc = null
    out = []
  }
}
