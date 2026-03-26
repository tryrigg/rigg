export function timestampNow(): string {
  return new Date().toISOString()
}

export function elapsedMs(startedAt: string, finishedAt: string): number {
  return Date.parse(finishedAt) - Date.parse(startedAt)
}

export function parseTimestampMs(value: string): number {
  return new Date(value).getTime()
}

export function parseOptionalTimestampMs(value: string | null): number | null {
  return value === null ? null : parseTimestampMs(value)
}

export function formatTimestampMs(value: number): string {
  return new Date(value).toISOString()
}

export function formatOptionalTimestampMs(value: number | null): string | null {
  return value === null ? null : formatTimestampMs(value)
}
