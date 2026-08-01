export function wavHeader(dataBytes: number, sampleRate: number, channels: number): Uint8Array {
  const buffer = new ArrayBuffer(44)
  const view = new DataView(buffer)
  const writeString = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, dataBytes, true)
  return new Uint8Array(buffer)
}

export function interleave(left: Float32Array, right: Float32Array, frames: number): Int16Array {
  const out = new Int16Array(frames * 2)
  for (let i = 0, j = 0; i < frames; i++) {
    let a = left[i]
    let b = right[i]
    a = a > 1 ? 1 : a < -1 ? -1 : a
    b = b > 1 ? 1 : b < -1 ? -1 : b
    out[j++] = a < 0 ? a * 0x8000 : a * 0x7fff
    out[j++] = b < 0 ? b * 0x8000 : b * 0x7fff
  }
  return out
}
