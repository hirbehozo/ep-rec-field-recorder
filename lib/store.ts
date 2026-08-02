import { emptyLibrary, isValidLibraryMap, type LibraryMap } from './library'
import type { SessionMeta } from './types'

const DIR_NAME = 'koii-rec'
const LIBRARY_FILE = 'library.json'

let dirHandle: FileSystemDirectoryHandle | null | undefined
const memFiles = new Map<string, Blob>()
let memLibrary: LibraryMap | null = null

async function getDir(): Promise<FileSystemDirectoryHandle | null> {
  if (dirHandle !== undefined) return dirHandle
  try {
    if (!navigator.storage?.getDirectory) throw new Error('OPFS unavailable')
    const root = await navigator.storage.getDirectory()
    dirHandle = await root.getDirectoryHandle(DIR_NAME, { create: true })
  } catch {
    dirHandle = null
  }
  return dirHandle
}

export async function isPersistent(): Promise<boolean> {
  return (await getDir()) !== null
}

export async function readIndex(): Promise<SessionMeta[]> {
  const dir = await getDir()
  if (!dir) return []
  try {
    const fh = await dir.getFileHandle('index.json')
    const text = await (await fh.getFile()).text()
    return JSON.parse(text) as SessionMeta[]
  } catch {
    return []
  }
}

export async function writeIndex(sessions: SessionMeta[]): Promise<void> {
  const dir = await getDir()
  if (!dir) return
  const fh = await dir.getFileHandle('index.json', { create: true })
  const w = await fh.createWritable()
  await w.write(new Blob([JSON.stringify(sessions)], { type: 'application/json' }))
  await w.close()
}

/**
 * The pad map is the product of many sessions of naming things — losing it
 * to a cleared browser storage would be worse than losing a take — so it's
 * kept in its own file rather than folded into a take's payload.
 */
export async function readLibrary(): Promise<LibraryMap> {
  const dir = await getDir()
  if (!dir) return memLibrary ?? emptyLibrary()
  try {
    const fh = await dir.getFileHandle(LIBRARY_FILE)
    const parsed: unknown = JSON.parse(await (await fh.getFile()).text())
    return isValidLibraryMap(parsed)
      ? { pads: parsed.pads, binds: parsed.binds || {} }
      : emptyLibrary()
  } catch {
    return emptyLibrary()
  }
}

export async function writeLibrary(map: LibraryMap): Promise<void> {
  const dir = await getDir()
  if (!dir) {
    memLibrary = map
    return
  }
  const fh = await dir.getFileHandle(LIBRARY_FILE, { create: true })
  const w = await fh.createWritable()
  await w.write(new Blob([JSON.stringify(map)], { type: 'application/json' }))
  await w.close()
}

export async function putFile(name: string, blob: Blob): Promise<void> {
  const dir = await getDir()
  if (dir) {
    const fh = await dir.getFileHandle(name, { create: true })
    const w = await fh.createWritable()
    await w.write(blob)
    await w.close()
    return
  }
  memFiles.set(name, blob)
}

/**
 * Raw file handle for a take in progress, for the caller to hand off to the
 * writer worker (createSyncAccessHandle is worker-only). Returns null when
 * OPFS is unavailable so the caller can fall back to accumulating chunks in
 * memory and building the file in one shot via putFile.
 */
export async function getWritableHandle(name: string): Promise<FileSystemFileHandle | null> {
  const dir = await getDir()
  if (!dir) return null
  return dir.getFileHandle(name, { create: true })
}

export async function getBlob(name: string): Promise<Blob> {
  const dir = await getDir()
  if (dir) {
    const fh = await dir.getFileHandle(name)
    return await fh.getFile()
  }
  const blob = memFiles.get(name)
  if (!blob) throw new Error(`${name} not found`)
  return blob
}

export async function removeSession(meta: SessionMeta): Promise<void> {
  if (!meta.mem) {
    const dir = await getDir()
    if (dir) {
      await dir.removeEntry(meta.wav).catch(() => {})
      await dir.removeEntry(meta.midi).catch(() => {})
      return
    }
  }
  memFiles.delete(meta.wav)
  memFiles.delete(meta.midi)
}

export function __resetForTests(): void {
  dirHandle = undefined
  memFiles.clear()
  memLibrary = null
}
