import { Blob } from 'buffer'
import '@testing-library/jest-dom'

// jsdom's Blob lacks arrayBuffer()/text(); Node's own implementation has them.
globalThis.Blob = Blob as unknown as typeof globalThis.Blob
