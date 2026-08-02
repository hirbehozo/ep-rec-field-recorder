import {
  bindForPad,
  bindKey,
  bindPad,
  clearPad,
  emptyLibrary,
  flaggedCount,
  namedCount,
  padForBind,
  padKey,
  searchPads,
  setPadName,
  togglePadFlag,
} from './library'

describe('library data model', () => {
  it('encodes pad and bind keys', () => {
    expect(padKey('A', 1)).toBe('A1')
    expect(padKey('D', 12)).toBe('D12')
    expect(bindKey(10, 42)).toBe('10:42')
  })

  it('a pad owns exactly one note: rebinding drops the pad from any other note', () => {
    let map = emptyLibrary()
    map = bindPad(map, bindKey(1, 60), 'A1')
    map = bindPad(map, bindKey(1, 61), 'A1')
    expect(Object.keys(map.binds)).toEqual([bindKey(1, 61)])
    expect(map.binds[bindKey(1, 61)]).toBe('A1')
  })

  it('a note maps to exactly one pad', () => {
    let map = emptyLibrary()
    map = bindPad(map, bindKey(1, 60), 'A1')
    map = bindPad(map, bindKey(1, 60), 'B2')
    expect(padForBind(map, 1, 60)).toBe('B2')
    expect(bindForPad(map, 'A1')).toBeNull()
    expect(bindForPad(map, 'B2')).toBe(bindKey(1, 60))
  })

  it('clearing a pad removes its name, flag and any binding', () => {
    let map = emptyLibrary()
    map = setPadName(map, 'A1', 'kick')
    map = togglePadFlag(map, 'A1')
    map = bindPad(map, bindKey(1, 60), 'A1')
    map = clearPad(map, 'A1')
    expect(map.pads.A1).toBeUndefined()
    expect(padForBind(map, 1, 60)).toBeNull()
  })

  it('setting an empty name with no flag drops the pad entry entirely', () => {
    let map = emptyLibrary()
    map = setPadName(map, 'A1', 'kick')
    map = setPadName(map, 'A1', '  ')
    expect(map.pads.A1).toBeUndefined()
  })

  it('setting an empty name keeps the entry if the pad is flagged', () => {
    let map = emptyLibrary()
    map = togglePadFlag(map, 'A1', 'kick')
    map = setPadName(map, 'A1', '')
    expect(map.pads.A1).toEqual({ name: '', flag: true })
  })

  it('counts named and flagged pads', () => {
    let map = emptyLibrary()
    map = setPadName(map, 'A1', 'kick')
    map = setPadName(map, 'A2', 'snare')
    map = togglePadFlag(map, 'A2')
    expect(namedCount(map)).toBe(2)
    expect(flaggedCount(map)).toBe(1)
  })

  it('empty search shows only flagged pads', () => {
    let map = emptyLibrary()
    map = setPadName(map, 'A1', 'kick')
    map = setPadName(map, 'A2', 'snare')
    map = togglePadFlag(map, 'A2')
    const rows = searchPads(map, '')
    expect(rows.map((r) => r.pad)).toEqual(['A2'])
  })

  it('a query filters by name or pad location regardless of flag state', () => {
    let map = emptyLibrary()
    map = setPadName(map, 'A1', 'kick drum')
    map = setPadName(map, 'B3', 'clap')
    const byName = searchPads(map, 'kick')
    expect(byName.map((r) => r.pad)).toEqual(['A1'])
    const byLocation = searchPads(map, 'b3')
    expect(byLocation.map((r) => r.pad)).toEqual(['B3'])
  })

  it('sorts results by name then pad location', () => {
    let map = emptyLibrary()
    map = setPadName(map, 'C1', 'banana')
    map = setPadName(map, 'A1', 'apple')
    const rows = searchPads(map, 'a')
    expect(rows.map((r) => r.pad)).toEqual(['A1', 'C1'])
  })
})
