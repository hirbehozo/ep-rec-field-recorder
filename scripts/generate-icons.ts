// Regenerates the app icons from scratch at each target size, rather than
// scaling one bitmap, so the dot-matrix glyphs stay crisp instead of
// blurring at smaller resolutions. Run with: node scripts/generate-icons.ts

import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { FONT } from '../lib/dotmatrix.ts'
import { crc32 } from '../lib/zip.ts'

interface RGBA {
  r: number
  g: number
  b: number
  a: number
}

function hex(c: string): RGBA {
  const n = parseInt(c.slice(1), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 255 }
}

const CASE = hex('#C9C7C2')
const LCD = hex('#A7B79C')
const INK = hex('#14130F')
const SIGNAL = hex('#F24E00')

// Proportions of a 512px canvas, read off reference/icon-512.png.
const WINDOW = { x0: 0.0977, y0: 0.1465, x1: 0.9023, y1: 0.4531 }
const KEY = { x0: 0.0977, y0: 0.5508, x1: 0.9023, y1: 0.7715 }
const WINDOW_RADIUS_FRAC = 0.0156
const KEY_RADIUS_FRAC = 0.0273
const BORDER_FRAC = 0.0078

function inRoundedRect(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
): boolean {
  if (px < x0 || px >= x1 || py < y0 || py >= y1) return false
  const rx = Math.min(radius, (x1 - x0) / 2)
  const ry = Math.min(radius, (y1 - y0) / 2)
  const nearLeft = px < x0 + rx
  const nearRight = px >= x1 - rx
  const nearTop = py < y0 + ry
  const nearBottom = py >= y1 - ry
  if ((nearLeft || nearRight) && (nearTop || nearBottom)) {
    const cx = nearLeft ? x0 + rx : x1 - rx
    const cy = nearTop ? y0 + ry : y1 - ry
    const dx = (px + 0.5 - cx) / (rx || 1)
    const dy = (py + 0.5 - cy) / (ry || 1)
    return dx * dx + dy * dy <= 1
  }
  return true
}

function drawRoundedRect(
  set: (x: number, y: number, c: RGBA) => void,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
  border: number,
  borderColor: RGBA,
  fillColor: RGBA,
): void {
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      if (!inRoundedRect(x, y, x0, y0, x1, y1, radius)) continue
      const inner = inRoundedRect(
        x,
        y,
        x0 + border,
        y0 + border,
        x1 - border,
        y1 - border,
        Math.max(0, radius - border),
      )
      set(x, y, inner ? fillColor : borderColor)
    }
  }
}

function drawText(
  set: (x: number, y: number, c: RGBA) => void,
  text: string,
  areaX0: number,
  areaY0: number,
  areaX1: number,
  areaY1: number,
  color: RGBA,
): void {
  const cols = text.length * 6 - 1
  const areaW = (areaX1 - areaX0) * 0.78
  const areaH = (areaY1 - areaY0) * 0.62
  const cell = Math.min(areaW / cols, areaH / 7)
  const dot = Math.max(1, cell * 0.72)
  const textW = cols * cell
  const textH = 7 * cell
  const startX = areaX0 + (areaX1 - areaX0 - textW) / 2
  const startY = areaY0 + (areaY1 - areaY0 - textH) / 2

  let gx = startX
  for (const ch of text) {
    const glyph = FONT[ch] ?? FONT['?']
    for (let c = 0; c < 5; c++) {
      for (let r = 0; r < 7; r++) {
        if (!(glyph[c] & (1 << r))) continue
        const dx0 = gx + c * cell
        const dy0 = startY + r * cell
        for (let y = Math.floor(dy0); y < Math.ceil(dy0 + dot); y++) {
          for (let x = Math.floor(dx0); x < Math.ceil(dx0 + dot); x++) set(x, y, color)
        }
      }
    }
    gx += 6 * cell
  }
}

function renderIcon(size: number, maskable: boolean): Buffer {
  const buf = new Uint8Array(size * size * 4)
  const set = (x: number, y: number, c: RGBA) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    const i = (y * size + x) * 4
    buf[i] = c.r
    buf[i + 1] = c.g
    buf[i + 2] = c.b
    buf[i + 3] = c.a
  }

  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, CASE)

  // Maskable icons get cropped into arbitrary shapes by the OS, so content
  // stays inside a safe zone while the background still fills the canvas
  // edge to edge (already true above).
  const contentScale = maskable ? 0.72 : 1
  const cx = size / 2
  const cy = size / 2
  const scaleRect = (r: { x0: number; y0: number; x1: number; y1: number }) => ({
    x0: cx + (r.x0 * size - cx) * contentScale,
    y0: cy + (r.y0 * size - cy) * contentScale,
    x1: cx + (r.x1 * size - cx) * contentScale,
    y1: cy + (r.y1 * size - cy) * contentScale,
  })

  const win = scaleRect(WINDOW)
  const key = scaleRect(KEY)
  const windowRadius = WINDOW_RADIUS_FRAC * size * contentScale
  const keyRadius = KEY_RADIUS_FRAC * size * contentScale
  const border = Math.max(1, Math.round(BORDER_FRAC * size * contentScale))

  drawRoundedRect(set, win.x0, win.y0, win.x1, win.y1, windowRadius, border, INK, LCD)
  drawText(
    set,
    'REC',
    win.x0 + border * 2,
    win.y0 + border * 2,
    win.x1 - border * 2,
    win.y1 - border * 2,
    INK,
  )
  drawRoundedRect(set, key.x0, key.y0, key.x1, key.y1, keyRadius, border, INK, SIGNAL)

  return Buffer.from(buf)
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcInput = Buffer.concat([typeBuf, data])
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(new Uint8Array(crcInput)), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function encodePNG(width: number, height: number, rgba: Buffer): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(width, 0)
  ihdrData.writeUInt32BE(height, 4)
  ihdrData[8] = 8 // bit depth
  ihdrData[9] = 6 // color type: RGBA
  ihdrData[10] = 0
  ihdrData[11] = 0
  ihdrData[12] = 0
  const ihdr = pngChunk('IHDR', ihdrData)

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const idat = pngChunk('IDAT', deflateSync(raw, { level: 9 }))
  const iend = pngChunk('IEND', Buffer.alloc(0))

  return Buffer.concat([signature, ihdr, idat, iend])
}

function writeIcon(path: string, size: number, maskable: boolean): void {
  const rgba = renderIcon(size, maskable)
  const png = encodePNG(size, size, rgba)
  writeFileSync(path, png)
  console.log(`wrote ${path} (${size}x${size}${maskable ? ', maskable' : ''})`)
}

writeIcon('public/icon-192.png', 192, false)
writeIcon('public/icon-512.png', 512, false)
writeIcon('public/icon-512-maskable.png', 512, true)
