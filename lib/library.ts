export type Group = 'A' | 'B' | 'C' | 'D'
export const GROUPS: Group[] = ['A', 'B', 'C', 'D']

// K.O. II keypad order: bottom-left is 1, and rows read left to right from
// the bottom up. Rendered three across, four down, so row one on screen is
// the top row (10 11 12) and the last row on screen is the bottom row
// (1 2 3) — getting this upside down makes the feature useless, since it
// stops matching the physical pads and auto-chop fill order.
export const PAD_ROWS: readonly number[][] = [
  [10, 11, 12],
  [7, 8, 9],
  [4, 5, 6],
  [1, 2, 3],
]

export interface PadEntry {
  name: string
  flag: boolean
}

export interface LibraryMap {
  pads: Record<string, PadEntry>
  binds: Record<string, string>
}

export function emptyLibrary(): LibraryMap {
  return { pads: {}, binds: {} }
}

export function padKey(group: Group, n: number): string {
  return group + n
}

export function bindKey(channel: number, note: number): string {
  return `${channel}:${note}`
}

/**
 * Rebinding removes any previous note pointing at this pad first, so a pad
 * owns exactly one note and a note maps to exactly one pad.
 */
export function bindPad(map: LibraryMap, key: string, pad: string): LibraryMap {
  const binds: Record<string, string> = {}
  for (const [k, v] of Object.entries(map.binds)) {
    if (v !== pad) binds[k] = v
  }
  binds[key] = pad
  return { ...map, binds }
}

export function padForBind(map: LibraryMap, channel: number, note: number): string | null {
  return map.binds[bindKey(channel, note)] ?? null
}

export function bindForPad(map: LibraryMap, pad: string): string | null {
  for (const [k, v] of Object.entries(map.binds)) if (v === pad) return k
  return null
}

export function setPadName(map: LibraryMap, pad: string, name: string): LibraryMap {
  const trimmed = name.trim()
  const flag = map.pads[pad]?.flag ?? false
  const pads = { ...map.pads }
  if (!trimmed && !flag) delete pads[pad]
  else pads[pad] = { name: trimmed, flag }
  return { ...map, pads }
}

export function togglePadFlag(map: LibraryMap, pad: string, fallbackName = ''): LibraryMap {
  const existing = map.pads[pad]
  const pads = {
    ...map.pads,
    [pad]: { name: existing?.name || fallbackName, flag: !existing?.flag },
  }
  return { ...map, pads }
}

export function clearPad(map: LibraryMap, pad: string): LibraryMap {
  const pads = { ...map.pads }
  delete pads[pad]
  const binds: Record<string, string> = {}
  for (const [k, v] of Object.entries(map.binds)) {
    if (v !== pad) binds[k] = v
  }
  return { pads, binds }
}

export interface LibraryRow {
  pad: string
  entry: PadEntry
}

/**
 * An empty query shows the flagged shortlist rather than every named pad,
 * which is what makes flagging worth doing instead of just decoration.
 */
export function searchPads(map: LibraryMap, query: string): LibraryRow[] {
  const q = query.trim().toLowerCase()
  let rows: LibraryRow[] = Object.entries(map.pads)
    .filter(([, entry]) => entry && (entry.name || entry.flag))
    .map(([pad, entry]) => ({ pad, entry }))
  rows = q
    ? rows.filter(
        ({ pad, entry }) => entry.name.toLowerCase().includes(q) || pad.toLowerCase().includes(q),
      )
    : rows.filter(({ entry }) => entry.flag)
  rows.sort((a, b) => a.entry.name.localeCompare(b.entry.name) || a.pad.localeCompare(b.pad))
  return rows.slice(0, 40)
}

export function namedCount(map: LibraryMap): number {
  return Object.values(map.pads).filter((p) => p && p.name).length
}

export function flaggedCount(map: LibraryMap): number {
  return Object.values(map.pads).filter((p) => p && p.flag).length
}

export function isValidLibraryMap(value: unknown): value is LibraryMap {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.pads === 'object' && v.pads !== null
}
