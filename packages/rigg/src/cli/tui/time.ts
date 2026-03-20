import type { RunSnapshot } from "../../session/schema"

function elapsedClockMs(startedAt: string | null, finishedAt: string | null, nowMs = Date.now()): number {
  if (startedAt === null) {
    return 0
  }

  const endMs = finishedAt === null ? nowMs : Date.parse(finishedAt)
  return Math.max(0, endMs - Date.parse(startedAt))
}

export function runDurationMs(snapshot: RunSnapshot, nowMs = Date.now()): number {
  return elapsedClockMs(snapshot.started_at, snapshot.finished_at ?? null, nowMs)
}

export function formatElapsed(startedAt: string | null, finishedAt: string | null, nowMs = Date.now()): string {
  const elapsed = Math.floor(elapsedClockMs(startedAt, finishedAt, nowMs) / 1000)
  const minutes = Math.floor(elapsed / 60)
  const seconds = elapsed % 60
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}
