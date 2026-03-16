export function timestampNow(): string {
  return new Date().toISOString()
}

export function elapsedMs(startedAt: string, finishedAt: string): number {
  return Date.parse(finishedAt) - Date.parse(startedAt)
}
