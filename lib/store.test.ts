import { __resetForTests, getBlob, putFile, readIndex, removeSession, writeIndex } from './store'
import type { SessionMeta } from './types'

// jsdom has no navigator.storage.getDirectory, so every test here exercises
// the in-memory fallback path transparently, same as a browser without OPFS.

function makeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'T1',
    n: 1,
    startedAt: new Date().toISOString(),
    duration: 1.5,
    sampleRate: 48000,
    channels: 2,
    device: 'test device',
    bpm: 120,
    clipped: false,
    offsetMs: 0,
    events: 0,
    ports: [],
    wav: 'T1.wav',
    midi: 'T1.midi.json',
    mem: true,
    ...overrides,
  }
}

beforeEach(() => {
  __resetForTests()
})

describe('store (in-memory fallback)', () => {
  it('readIndex returns an empty array with no persistence backing it', async () => {
    expect(await readIndex()).toEqual([])
  })

  it('writeIndex does not throw when there is nothing to persist to', async () => {
    await expect(writeIndex([makeMeta()])).resolves.toBeUndefined()
  })

  it('putFile/getBlob round-trip through memory', async () => {
    const blob = new Blob(['hello'], { type: 'text/plain' })
    await putFile('a.txt', blob)
    const back = await getBlob('a.txt')
    expect(await back.text()).toBe('hello')
  })

  it('getBlob throws for a file that was never written', async () => {
    await expect(getBlob('missing.wav')).rejects.toThrow()
  })

  it('removeSession deletes both files for a memory-backed session', async () => {
    const meta = makeMeta()
    await putFile(meta.wav, new Blob(['wav bytes']))
    await putFile(meta.midi, new Blob(['{}']))
    await removeSession(meta)
    await expect(getBlob(meta.wav)).rejects.toThrow()
    await expect(getBlob(meta.midi)).rejects.toThrow()
  })
})
