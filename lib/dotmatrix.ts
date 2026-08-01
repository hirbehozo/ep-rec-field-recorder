export const DM_COLS = 96
export const DM_ROWS = 54

// Verbatim from the prototype: 5x7 bitmap font as column bytes, proof-read glyph by glyph.
const FONT: Record<string, number[]> = {
  ' ': [0, 0, 0, 0, 0],
  '0': [62, 81, 73, 69, 62],
  '1': [0, 66, 127, 64, 0],
  '2': [66, 97, 81, 73, 70],
  '3': [33, 65, 69, 75, 49],
  '4': [24, 20, 18, 127, 16],
  '5': [39, 69, 69, 69, 57],
  '6': [60, 74, 73, 73, 48],
  '7': [1, 113, 9, 5, 3],
  '8': [54, 73, 73, 73, 54],
  '9': [6, 73, 73, 41, 30],
  A: [126, 9, 9, 9, 126],
  B: [127, 73, 73, 73, 54],
  C: [62, 65, 65, 65, 34],
  D: [127, 65, 65, 34, 28],
  E: [127, 73, 73, 73, 65],
  F: [127, 9, 9, 9, 1],
  G: [62, 65, 73, 73, 122],
  H: [127, 8, 8, 8, 127],
  I: [0, 65, 127, 65, 0],
  J: [32, 64, 65, 63, 1],
  K: [127, 8, 20, 34, 65],
  L: [127, 64, 64, 64, 64],
  M: [127, 2, 12, 2, 127],
  N: [127, 4, 8, 16, 127],
  O: [62, 65, 65, 65, 62],
  P: [127, 9, 9, 9, 6],
  Q: [62, 65, 81, 33, 94],
  R: [127, 9, 25, 41, 70],
  S: [70, 73, 73, 73, 49],
  T: [1, 1, 127, 1, 1],
  U: [63, 64, 64, 64, 63],
  V: [31, 32, 64, 32, 31],
  W: [127, 32, 24, 32, 127],
  X: [99, 20, 8, 20, 99],
  Y: [3, 4, 120, 4, 3],
  Z: [97, 81, 73, 69, 67],
  ':': [0, 0, 54, 0, 0],
  '.': [0, 0, 96, 96, 0],
  '-': [8, 8, 8, 8, 8],
  '/': [96, 16, 8, 4, 3],
  '+': [8, 8, 62, 8, 8],
  '#': [28, 62, 62, 62, 28],
  '!': [0, 0, 95, 0, 0],
  '*': [17, 10, 4, 10, 17],
  '>': [0, 34, 20, 8, 0],
  '<': [0, 8, 20, 34, 0],
  '=': [20, 20, 20, 20, 20],
  '?': [2, 1, 89, 5, 2],
  _: [64, 64, 64, 64, 64],
}

export class DotMatrix {
  readonly cols = DM_COLS
  readonly rows = DM_ROWS
  buf: Uint8Array
  pitch = 4
  dot = 3
  dpr = 1
  private ctx: CanvasRenderingContext2D | null = null
  private pattern: CanvasPattern | null = null

  constructor() {
    this.buf = new Uint8Array(DM_COLS * DM_ROWS)
  }

  plot(x: number, y: number, v: number): void {
    if (x < 0 || y < 0 || x >= DM_COLS || y >= DM_ROWS) return
    this.buf[y * DM_COLS + x] = v
  }

  char(ch: string, x: number, y: number, s: number, v: number): number {
    const g = FONT[ch] ?? FONT['?']
    for (let c = 0; c < 5; c++) {
      for (let r = 0; r < 7; r++) {
        if (!(g[c] & (1 << r))) continue
        for (let a = 0; a < s; a++)
          for (let b = 0; b < s; b++) this.plot(x + c * s + a, y + r * s + b, v)
      }
    }
    return x + 5 * s + s // advance including one scaled space
  }

  text(str: string, x: number, y: number, s: number, v: number): number {
    let cx = x
    for (const ch of String(str).toUpperCase()) cx = this.char(ch, cx, y, s, v)
    return cx
  }

  width(str: string, s: number): number {
    return String(str).length * 6 * s - s
  }

  right(str: string, xEnd: number, y: number, s: number, v: number): void {
    this.text(str, xEnd - this.width(str, s), y, s, v)
  }

  bar(x0: number, x1: number, y: number, h: number, frac: number, hotFrom: number): void {
    const n = x1 - x0
    const lit = Math.round(Math.max(0, Math.min(1, frac)) * n)
    for (let i = 0; i < lit; i++) {
      const v = i / n >= hotFrom ? 2 : 1
      for (let r = 0; r < h; r++) this.plot(x0 + i, y + r, v)
    }
    // end-of-scale tick so the ceiling is always visible
    for (let r = 0; r < h; r++) this.plot(x1, y + r, 1)
  }

  clear(): void {
    this.buf.fill(0)
  }

  fill(): void {
    this.buf.fill(1)
  }

  resize(canvas: HTMLCanvasElement): void {
    const w = canvas.clientWidth
    if (!w) return
    this.dpr = Math.min(3, window.devicePixelRatio || 1)
    const pitch = w / DM_COLS
    canvas.style.height = `${pitch * DM_ROWS}px`
    canvas.width = Math.round(w * this.dpr)
    canvas.height = Math.round(pitch * DM_ROWS * this.dpr)
    this.pitch = pitch * this.dpr
    this.dot = Math.max(1, Math.round(this.pitch * 0.72))
    this.ctx = canvas.getContext('2d')
    // pre-render the unlit dot field once, then stamp it as a pattern each frame
    const p = document.createElement('canvas')
    p.width = p.height = Math.max(1, Math.round(this.pitch))
    const pc = p.getContext('2d')
    if (pc) {
      pc.fillStyle = 'rgba(20,28,14,.11)'
      pc.fillRect(0, 0, this.dot, this.dot)
    }
    this.pattern = this.ctx?.createPattern(p, 'repeat') ?? null
  }

  render(): void {
    const ctx = this.ctx
    if (!ctx) return
    const w = ctx.canvas.width
    const h = ctx.canvas.height
    ctx.clearRect(0, 0, w, h)
    if (this.pattern) {
      ctx.fillStyle = this.pattern
      ctx.fillRect(0, 0, w, h)
    }
    for (const [val, col] of [
      [1, '#141C0E'],
      [2, '#F24E00'],
    ] as const) {
      ctx.beginPath()
      for (let y = 0; y < DM_ROWS; y++) {
        const row = y * DM_COLS
        for (let x = 0; x < DM_COLS; x++) {
          if (this.buf[row + x] !== val) continue
          ctx.rect(x * this.pitch, y * this.pitch, this.dot, this.dot)
        }
      }
      ctx.fillStyle = col
      ctx.fill()
    }
  }
}
