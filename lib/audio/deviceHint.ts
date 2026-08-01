export const HARDWARE_HINT = /usb|sidekick|ep-1|interface|teenage|audio/i

export function looksLikeHardware(label: string): boolean {
  return HARDWARE_HINT.test(label)
}
