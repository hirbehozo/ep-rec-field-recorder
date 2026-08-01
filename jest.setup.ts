import { Blob } from 'buffer'
import { TextDecoder, TextEncoder } from 'util'
import '@testing-library/jest-dom'

// jsdom's Blob lacks arrayBuffer()/text(); Node's own implementation has them.
globalThis.Blob = Blob as unknown as typeof globalThis.Blob

// jsdom's test environment does not expose these globals at all.
globalThis.TextEncoder = TextEncoder as unknown as typeof globalThis.TextEncoder
globalThis.TextDecoder = TextDecoder as unknown as typeof globalThis.TextDecoder
