import { encodeMp3 } from './audio/mp3'
import { buildSMF } from './smf'
import { getBlob } from './store'
import type { SessionMeta, SessionPayload } from './types'
import { buildZip, type ZipEntry } from './zip'

async function loadPayload(meta: SessionMeta): Promise<SessionPayload> {
  const blob = await getBlob(meta.midi)
  return JSON.parse(await blob.text()) as SessionPayload
}

export async function exportWav(meta: SessionMeta): Promise<File> {
  const blob = await getBlob(meta.wav)
  return new File([blob], `${meta.id}.wav`, { type: 'audio/wav' })
}

export async function exportJson(meta: SessionMeta): Promise<File> {
  const payload = await loadPayload(meta)
  return new File([JSON.stringify(payload, null, 1)], `${meta.id}.json`, {
    type: 'application/json',
  })
}

/**
 * Built on demand from the stored events using the take's BPM and the
 * *current* offset, not whatever offset was set when the take was recorded
 * — so nudging the offset and re-exporting an old take shifts it correctly.
 */
export async function exportMidi(meta: SessionMeta, offsetMs: number): Promise<File> {
  const payload = await loadPayload(meta)
  const blob = buildSMF(payload.events, meta.bpm ?? 120, offsetMs)
  return new File([blob], `${meta.id}.mid`, { type: 'audio/midi' })
}

/**
 * MP3 is a convenience copy for sharing, not the archive — the WAV is.
 * Encoded on demand at the given bitrate, roughly 3-10x realtime depending
 * on the phone, so a long take takes a while; onProgress drives a button
 * label rather than leaving the UI looking stuck.
 */
export async function exportMp3(
  meta: SessionMeta,
  bitrate: number,
  onProgress?: (fraction: number) => void,
): Promise<File> {
  const wavBlob = await getBlob(meta.wav)
  const mp3Blob = await encodeMp3(wavBlob, meta.sampleRate, { bitrate, onProgress })
  return new File([mp3Blob], `${meta.id}.mp3`, { type: 'audio/mpeg' })
}

export async function exportAllZip(meta: SessionMeta, offsetMs: number): Promise<File> {
  const [wav, midi, json] = await Promise.all([
    exportWav(meta),
    exportMidi(meta, offsetMs),
    exportJson(meta),
  ])
  const entries: ZipEntry[] = await Promise.all(
    [wav, midi, json].map(async (f) => ({
      name: f.name,
      data: new Uint8Array(await f.arrayBuffer()),
    })),
  )
  const blob = buildZip(entries)
  return new File([blob], `${meta.id}.zip`, { type: 'application/zip' })
}

function downloadFile(file: File): void {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

// The share sheet is the good path specifically on mobile (Android has a
// reliable "save to device" entry in it). Desktop share panels (e.g. macOS)
// don't consistently offer a plain save-to-disk option, so a direct
// download there is more reliable than routing through the sheet.
function isMobileLike(): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
}

/**
 * navigator.share with files on mobile when canShare accepts them (the good
 * path on Android), falling back to an object URL download everywhere else.
 * AbortError just means the user dismissed the share sheet, so it is
 * swallowed silently.
 */
export async function shareOrDownload(file: File): Promise<void> {
  try {
    if (isMobileLike() && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: file.name })
      return
    }
    downloadFile(file)
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return
    throw e
  }
}
