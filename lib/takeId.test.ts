import { makeTakeId } from './takeId'

describe('makeTakeId', () => {
  it('formats a fixed date into a stable id', () => {
    expect(makeTakeId(new Date('2026-08-01T12:34:56.789Z'))).toBe('T20260801123456')
  })

  it('always starts with T and is 15 characters long', () => {
    const id = makeTakeId(new Date())
    expect(id).toMatch(/^T\d{14}$/)
    expect(id).toHaveLength(15)
  })
})
