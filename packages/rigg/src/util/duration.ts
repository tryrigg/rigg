const unitMs = {
  h: 60 * 60 * 1000,
  m: 60 * 1000,
  ms: 1,
  s: 1000,
} as const

export function parseDuration(input: string): number | null {
  const match = input.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/)
  if (match === null) {
    return null
  }

  const value = Number(match[1])
  const unit = match[2] as keyof typeof unitMs
  if (!Number.isFinite(value)) {
    return null
  }

  return Math.round(value * unitMs[unit])
}
