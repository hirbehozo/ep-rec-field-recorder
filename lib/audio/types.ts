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
}

export type WorkletMessage = PcmMessage | MeterMessage
