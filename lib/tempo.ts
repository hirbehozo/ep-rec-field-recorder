const CLOCKS_PER_QUARTER = 24
const MIN_SAMPLES = 25
const MIN_BPM = 20
const MAX_BPM = 400

/**
 * Reconciles the prototype's two call sites (a rolling 25-sample live window
 * and the full clocks array collected over a take) into one function: the
 * caller picks the window, this just needs at least MIN_SAMPLES timestamps.
 */
export function bpmFromClocks(timestamps: number[]): number | null {
  if (timestamps.length < MIN_SAMPLES) return null
  const span = timestamps[timestamps.length - 1] - timestamps[0]
  if (span <= 0) return null
  const quarters = (timestamps.length - 1) / CLOCKS_PER_QUARTER
  const bpm = (60000 * quarters) / span
  if (!(bpm > MIN_BPM && bpm < MAX_BPM)) return null
  return bpm
}
