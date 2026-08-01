import { buildZip, crc32, type ZipEntry } from './zip'

interface ParsedEntry {
  name: string
  data: Uint8Array
  crc: number
  method: number
}

/** Minimal zip reader driven entirely off the central directory, just enough to verify buildZip's output. */
async function parseZip(blob: Blob): Promise<ParsedEntry[]> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const view = new DataView(bytes.buffer)

  // find EOCD by scanning back from the end (comment is always empty here)
  let eocdOffset = -1
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset < 0) throw new Error('EOCD not found')

  const entryCount = view.getUint16(eocdOffset + 10, true)
  const centralDirOffset = view.getUint32(eocdOffset + 16, true)

  const entries: ParsedEntry[] = []
  let pos = centralDirOffset
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) throw new Error('bad central dir signature')
    const method = view.getUint16(pos + 10, true)
    const crc = view.getUint32(pos + 16, true)
    const compressedSize = view.getUint32(pos + 20, true)
    const nameLength = view.getUint16(pos + 28, true)
    const extraLength = view.getUint16(pos + 30, true)
    const commentLength = view.getUint16(pos + 32, true)
    const localOffset = view.getUint32(pos + 42, true)
    const name = new TextDecoder().decode(bytes.slice(pos + 46, pos + 46 + nameLength))

    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const data = bytes.slice(dataStart, dataStart + compressedSize)

    entries.push({ name, data, crc, method })
    pos += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function entry(name: string, text: string): ZipEntry {
  return { name, data: new TextEncoder().encode(text) }
}

describe('crc32', () => {
  it('matches the standard CRC-32 check values', () => {
    expect(crc32(new TextEncoder().encode(''))).toBe(0)
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })
})

describe('buildZip', () => {
  it('round-trips a single entry with matching name, bytes and crc', async () => {
    const zip = buildZip([entry('take.json', '{"a":1}')])
    const parsed = await parseZip(zip)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].name).toBe('take.json')
    expect(new TextDecoder().decode(parsed[0].data)).toBe('{"a":1}')
    expect(parsed[0].crc).toBe(crc32(new TextEncoder().encode('{"a":1}')))
  })

  it('stores entries uncompressed (method 0)', async () => {
    const zip = buildZip([entry('a.txt', 'hello')])
    const parsed = await parseZip(zip)
    expect(parsed[0].method).toBe(0)
  })

  it('round-trips multiple entries in order with distinct content', async () => {
    const entries = [
      entry('T1.wav', 'wav-bytes'),
      entry('T1.mid', 'midi-bytes'),
      entry('T1.json', 'json-bytes'),
    ]
    const zip = buildZip(entries)
    const parsed = await parseZip(zip)
    expect(parsed.map((e) => e.name)).toEqual(['T1.wav', 'T1.mid', 'T1.json'])
    expect(parsed.map((e) => new TextDecoder().decode(e.data))).toEqual([
      'wav-bytes',
      'midi-bytes',
      'json-bytes',
    ])
  })

  it('handles binary data containing every byte value', async () => {
    const data = new Uint8Array(256)
    for (let i = 0; i < 256; i++) data[i] = i
    const zip = buildZip([{ name: 'bin.dat', data }])
    const parsed = await parseZip(zip)
    expect(Array.from(parsed[0].data)).toEqual(Array.from(data))
    expect(parsed[0].crc).toBe(crc32(data))
  })

  it('produces an empty archive with a valid EOCD for zero entries', async () => {
    const zip = buildZip([])
    const parsed = await parseZip(zip)
    expect(parsed).toHaveLength(0)
  })
})
