import type { SessionMeta } from './types'

const DIR_NAME = 'koii-rec'

let dirHandle: FileSystemDirectoryHandle | null | undefined
const memFiles = new Map<string, Blob>()

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
}
