import { useCallback, useEffect, useRef, useState } from 'react'
import {
  bindKey,
  bindPad,
  clearPad,
  emptyLibrary,
  padForBind,
  setPadName,
  togglePadFlag,
  type Group,
  type LibraryMap,
} from './library'
import { readLibrary, writeLibrary } from './store'

const HIGHLIGHT_MS = 260

export function useLibrary() {
  const [map, setMap] = useState<LibraryMap>(emptyLibrary())
  const [group, setGroup] = useState<Group>('A')
  const [selected, setSelected] = useState<string | null>(null)
  const [learning, setLearning] = useState(false)
  const [hitPad, setHitPad] = useState<string | null>(null)

  // Note-on messages can arrive between renders, so every value the handler
  // reads is mirrored into a ref rather than trusted to be current in a
  // closure created on an earlier render.
  const mapRef = useRef(map)
  mapRef.current = map
  const learningRef = useRef(learning)
  learningRef.current = learning
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const hitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    readLibrary().then(setMap)
  }, [])

  useEffect(() => {
    return () => {
      if (hitTimerRef.current) clearTimeout(hitTimerRef.current)
    }
  }, [])

  const persist = useCallback((next: LibraryMap) => {
    setMap(next)
    void writeLibrary(next)
  }, [])

  const selectGroup = useCallback((g: Group) => {
    setGroup(g)
    setSelected(null)
    setLearning(false)
  }, [])

  const selectPad = useCallback((pad: string) => {
    setSelected((s) => (s === pad ? null : pad))
    setLearning(false)
  }, [])

  const toggleLearn = useCallback(() => {
    if (!selectedRef.current) return
    setLearning((v) => !v)
  }, [])

  const saveName = useCallback(
    (name: string) => {
      const key = selectedRef.current
      if (!key) return
      persist(setPadName(mapRef.current, key, name))
      setSelected(null)
    },
    [persist],
  )

  const toggleFlag = useCallback(
    (currentInputValue: string) => {
      const key = selectedRef.current
      if (!key) return
      persist(togglePadFlag(mapRef.current, key, currentInputValue))
    },
    [persist],
  )

  const clearSelected = useCallback(() => {
    const key = selectedRef.current
    if (!key) return
    persist(clearPad(mapRef.current, key))
    setSelected(null)
  }, [persist])

  const importMap = useCallback(
    (next: LibraryMap) => {
      persist(next)
      setSelected(null)
      setLearning(false)
    },
    [persist],
  )

  const wipe = useCallback(() => {
    persist(emptyLibrary())
    setSelected(null)
    setLearning(false)
  }, [persist])

  const jumpTo = useCallback((pad: string) => {
    setGroup(pad[0] as Group)
    setSelected(pad)
    setLearning(false)
  }, [])

  /**
   * Called for every note-on from an armed, non-Sidekick port (the caller
   * filters port kind — a Sidekick has no pads to bind). While in learn
   * mode this binds the note to the selected pad, evicting any note that
   * previously pointed at it. Otherwise it's a live hit: flash the pad for
   * ~260ms, and if the tab is currently visible, follow a hit into another
   * group so the grid always shows what's playing.
   */
  const onNoteOn = useCallback(
    (channel: number, note: number, tabVisible: boolean) => {
      const key = bindKey(channel, note)
      if (learningRef.current && selectedRef.current) {
        persist(bindPad(mapRef.current, key, selectedRef.current))
        setLearning(false)
        return
      }
      const pad = padForBind(mapRef.current, channel, note)
      if (!pad) return
      if (tabVisible) setGroup((g) => (pad[0] !== g ? (pad[0] as Group) : g))
      setHitPad(pad)
      if (hitTimerRef.current) clearTimeout(hitTimerRef.current)
      hitTimerRef.current = setTimeout(() => setHitPad(null), HIGHLIGHT_MS)
    },
    [persist],
  )

  return {
    map,
    group,
    selected,
    learning,
    hitPad,
    selectGroup,
    selectPad,
    toggleLearn,
    saveName,
    toggleFlag,
    clearSelected,
    importMap,
    wipe,
    jumpTo,
    onNoteOn,
  }
}

export type UseLibraryReturn = ReturnType<typeof useLibrary>
