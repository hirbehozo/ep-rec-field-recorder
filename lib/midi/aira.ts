// Roland Aira Compact (S-1, J-6, T-8, E-4, P-6): class-compliant USB-C
// audio/MIDI interfaces, no special CC decoding needed unlike the EP-136,
// but their notes still have to be kept out of the library tab's pad
// binding — an Aira note is not a K.O. II pad hit.
// Word-boundary anchored, unlike a bare [sjtep]-[1468]: without it this
// matches "P-1" inside "EP-133" and misclassifies the K.O. II's own port as
// an Aira, silently dropping its pad hits from the library tab's binding.
const AIRA_HINT = /aira|roland|\b[sjtep]-[1468]\b/i

export function looksLikeAira(portName: string): boolean {
  return AIRA_HINT.test(portName)
}
