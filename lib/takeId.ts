export function makeTakeId(date: Date = new Date()): string {
  return (
    'T' +
    date
      .toISOString()
      .replace(/[-:T.Z]/g, '')
      .slice(0, 14)
  )
}
