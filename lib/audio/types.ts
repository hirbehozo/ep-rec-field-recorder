export interface PcmMessage {
  type: 'pcm'
  l: Float32Array
  r: Float32Array
  frames: number
}

export interface MeterMessage {
  type: 'meter'
  pl: number
  pr: number
  // Running |L-R| / (L+R) magnitude since the last meter tick, for mono
  // detection, and the worklet's cumulative pool-starvation count.
  diff: number
  starve: number
}

export interface DiscontinuityMessage {
  type: 'discontinuity'
  missingFrames: number
  expectedFrames: number
}

export type WorkletMessage = PcmMessage | MeterMessage | DiscontinuityMessage
