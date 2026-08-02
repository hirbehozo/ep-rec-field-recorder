'use client'

import { useMemo, useRef, useState } from 'react'
import { shareOrDownload } from '@/lib/export'
import {
  bindForPad,
  flaggedCount,
  GROUPS,
  namedCount,
  PAD_ROWS,
  padKey,
  searchPads,
  isValidLibraryMap,
  type Group,
} from '@/lib/library'
import type { UseLibraryReturn } from '@/lib/useLibrary'

function buzz(ms: number): void {
  try {
    navigator.vibrate?.(ms)
  } catch {
    // vibration is a nicety, never worth failing over
  }
}

const clean = (s: string) => s.replace(/[<>&]/g, '')

export default function LibraryTab({ library }: { library: UseLibraryReturn }) {
  const { map, group, selected, learning, hitPad } = library
  const [query, setQuery] = useState('')
  const [nameDraft, setNameDraft] = useState('')
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  const selectedEntry = selected ? map.pads[selected] : undefined
  const boundKey = selected ? bindForPad(map, selected) : null

  // The input is uncontrolled-ish across selection changes: re-seed the
  // draft whenever the selected pad changes, but let typing move freely.
  const seededForRef = useRef<string | null>(null)
  if (seededForRef.current !== selected) {
    seededForRef.current = selected
    setNameDraft(selectedEntry?.name || '')
  }

  const rows = useMemo(() => searchPads(map, query), [map, query])

  const hint = learning
    ? 'hit the pad on the device'
    : selected
      ? `editing ${selected}`
      : 'tap a pad to name it'

  const onExportMap = async () => {
    const file = new File([JSON.stringify(map, null, 1)], 'ep-rec-library.json', {
      type: 'application/json',
    })
    await shareOrDownload(file).catch(() => {})
  }

  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setImportError(null)
    try {
      const parsed: unknown = JSON.parse(await file.text())
      if (!isValidLibraryMap(parsed)) throw new Error('that file has no pad map in it')
      library.importMap({ pads: parsed.pads, binds: parsed.binds || {} })
    } catch (err) {
      setImportError(`Import failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const onWipe = () => {
    if (!window.confirm('Clear every name, flag and binding? This cannot be undone.')) return
    library.wipe()
  }

  return (
    <div>
      <div className="section-hdr">
        <span className="tag">Find</span>
        <span className="rule" />
        <span className="val">
          {namedCount(map)} named{flaggedCount(map) ? ` / ${flaggedCount(map)} flagged` : ''}
        </span>
      </div>
      <input
        className="search"
        placeholder="search samples"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div>
        {rows.length === 0 ? (
          <div className="empty-state">
            {query
              ? 'Nothing matches that.'
              : 'Flagged samples show here. Search to find anything by name.'}
          </div>
        ) : (
          rows.map(({ pad, entry }) => (
            <div
              key={pad}
              className="hit-list"
              onClick={() => {
                library.jumpTo(pad)
                buzz(8)
              }}
            >
              <span className="loc">{pad}</span>
              <span className="nm">{clean(entry.name) || 'unnamed'}</span>
              {entry.flag && <span className="fl">flagged</span>}
            </div>
          ))
        )}
      </div>

      <div className="section-hdr">
        <span className="tag">Pads</span>
        <span className="rule" />
        <span className="val">{hint}</span>
      </div>
      <div className="groups">
        {GROUPS.map((g) => (
          <button
            key={g}
            type="button"
            className="key mini"
            style={
              g === group
                ? { background: 'var(--color-ink)', color: 'var(--color-face-hi)' }
                : undefined
            }
            onClick={() => {
              library.selectGroup(g as Group)
              buzz(8)
            }}
          >
            group {g}
          </button>
        ))}
      </div>
      <div className="padgrid">
        {PAD_ROWS.flat().map((n) => {
          const key = padKey(group, n)
          const entry = map.pads[key]
          const classes = [
            'pad',
            entry?.name ? '' : 'empty',
            entry?.flag ? 'flagged' : '',
            selected === key ? 'sel' : '',
            hitPad === key ? 'hit' : '',
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <div
              key={key}
              className={classes}
              data-pad={key}
              onClick={() => {
                library.selectPad(key)
                buzz(8)
              }}
            >
              <span className="num">{key}</span>
              <span className="nm">{clean(entry?.name || '') || 'empty'}</span>
            </div>
          )
        })}
      </div>

      {selected && (
        <div className="editor">
          <input
            placeholder="name this sample"
            maxLength={28}
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
          />
          <div className="row2">
            <button
              type="button"
              className="key mini"
              onClick={() => {
                library.saveName(nameDraft)
                buzz(12)
              }}
            >
              save
            </button>
            <button
              type="button"
              className="key mini"
              onClick={() => {
                library.toggleFlag(nameDraft)
                buzz(12)
              }}
            >
              {selectedEntry?.flag ? 'unflag' : 'flag'}
            </button>
            <button
              type="button"
              className="key mini"
              onClick={() => {
                library.toggleLearn()
                buzz(8)
              }}
            >
              {learning ? 'listening' : boundKey ? 'rebind' : 'bind pad'}
            </button>
            <button
              type="button"
              className="key mini del"
              onClick={() => {
                library.clearSelected()
              }}
            >
              clear
            </button>
          </div>
          <div className="empty-state" style={{ paddingTop: 8 }}>
            {boundKey
              ? `bound to midi ${boundKey.replace(':', ' note ')}`
              : 'not bound yet. press bind pad, then hit the pad on the K.O. II.'}
          </div>
        </div>
      )}

      <div className="section-hdr">
        <span className="tag">Map</span>
        <span className="rule" />
      </div>
      <div className="acts" style={{ paddingTop: 2 }}>
        <button type="button" className="key mini" onClick={onExportMap}>
          export map
        </button>
        <button type="button" className="key mini" onClick={() => importInputRef.current?.click()}>
          import map
        </button>
        <button type="button" className="key mini del" onClick={onWipe}>
          clear all
        </button>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={onImportFile}
        />
      </div>
      {importError && <div className="panel-msg">{importError}</div>}
      <div className="empty-state" style={{ paddingTop: 10 }}>
        Names and flags live only in this app. Nothing is ever written back to the K.O. II, so there
        is no way for this to damage what is on the device.
      </div>
    </div>
  )
}
