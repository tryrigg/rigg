const MIN_RUN_ID_PREFIX = 13

export function normalizeRunId(runId: string): string {
  return runId.replace(/-/g, "").toLowerCase()
}

function sharedPrefix(left: string, right: string): number {
  const max = Math.min(left.length, right.length)
  let i = 0
  while (i < max && left[i] === right[i]) {
    i += 1
  }
  return i
}

function shortLen(current: string, left?: string, right?: string): number {
  return [left, right].reduce((max, id) => {
    if (id === undefined || id === current) {
      return max
    }
    return Math.max(max, sharedPrefix(current, id) + 1)
  }, MIN_RUN_ID_PREFIX)
}

export function shortRunIdNear(runId: string, left?: string, right?: string): string {
  const current = normalizeRunId(runId)
  return current.slice(
    0,
    shortLen(
      current,
      left === undefined ? undefined : normalizeRunId(left),
      right === undefined ? undefined : normalizeRunId(right),
    ),
  )
}
