import { Box, Text, useStdout } from "ink"

import { normalizeRunId } from "../../history/id"
import type { RunSnapshot } from "../../session/schema"
import { renderRule } from "./layout"
import { formatDuration, statusSymbol } from "./symbols"
import { runDurationMs } from "./time"
import { SUMMARY_KINDS, type TreeEntry } from "./tree"

type FailedStep = {
  label: string
  suffix: string
}

type StatusCounts = {
  failedCount: number
  failedSteps: FailedStep[]
  interruptedCount: number
  skippedCount: number
  succeededCount: number
}

function createStatusCounts(): StatusCounts {
  return {
    failedCount: 0,
    failedSteps: [],
    interruptedCount: 0,
    skippedCount: 0,
    succeededCount: 0,
  }
}

function isSummaryEntry(entry: TreeEntry): boolean {
  return entry.entryType === "step" && SUMMARY_KINDS.has(entry.nodeKind)
}

export function countStatuses(entries: TreeEntry[]): StatusCounts {
  return entries.reduce((counts, entry) => {
    if (!isSummaryEntry(entry)) {
      return counts
    }

    switch (entry.status) {
      case "failed":
        counts.failedCount += 1
        counts.failedSteps.push({ label: entry.label, suffix: entry.suffix })
        return counts
      case "interrupted":
        counts.interruptedCount += 1
        return counts
      case "skipped":
        counts.skippedCount += 1
        return counts
      case "succeeded":
        counts.succeededCount += 1
        return counts
      default:
        return counts
    }
  }, createStatusCounts())
}

export function summaryRunId(runId: string): string {
  return `run ${normalizeRunId(runId)}`
}

export function Summary({ snapshot, entries }: { snapshot: RunSnapshot | null; entries: TreeEntry[] }) {
  if (snapshot === null) {
    return null
  }

  const stdout = useStdout().stdout
  const cols = stdout?.columns ?? 80

  const counts = countStatuses(entries)
  const totalMs = runDurationMs(snapshot)
  const statusLabel = snapshot.status.charAt(0).toUpperCase() + snapshot.status.slice(1)
  const statusColor = snapshot.status === "succeeded" ? "green" : "red"

  const succeededSym = statusSymbol("succeeded")
  const failedSym = statusSymbol("failed")
  const interruptedSym = statusSymbol("interrupted")
  const skippedSym = statusSymbol("skipped")

  return (
    <Box flexDirection="column">
      <Text>{""}</Text>
      <Text dimColor>{renderRule(cols)}</Text>
      <Box>
        <Box flexGrow={1}>
          <Text>
            {"  "}
            <Text color={succeededSym.color}>
              {succeededSym.icon} {counts.succeededCount} succeeded
            </Text>
            {counts.failedCount > 0 && (
              <Text color={failedSym.color}>
                {"  "}
                {failedSym.icon} {counts.failedCount} failed
              </Text>
            )}
            {counts.interruptedCount > 0 && (
              <Text color={interruptedSym.color}>
                {"  "}
                {interruptedSym.icon} {counts.interruptedCount} interrupted
              </Text>
            )}
            {counts.skippedCount > 0 && (
              <Text color={skippedSym.color}>
                {"  "}
                {skippedSym.icon} {counts.skippedCount} skipped
              </Text>
            )}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>
            {formatDuration(totalMs)}
            {"  "}
          </Text>
        </Box>
      </Box>
      {counts.failedSteps.length > 0 && <Text>{""}</Text>}
      {counts.failedSteps.length > 0 &&
        counts.failedSteps.map((step, i) => (
          <Text key={i} color="red">
            {"    "}
            {failedSym.icon} {step.label}
            {step.suffix ? `  ${step.suffix}` : ""}
          </Text>
        ))}
      <Text>{""}</Text>
      <Text>
        {"  "}
        <Text bold color={statusColor}>
          {statusLabel}
        </Text>
        {snapshot.reason && snapshot.reason !== "completed" && (
          <Text dimColor>
            {"  "}
            {snapshot.reason}
          </Text>
        )}
      </Text>
      <Text>{""}</Text>
      <Text dimColor>
        {"  "}
        {summaryRunId(snapshot.run_id)}
      </Text>
    </Box>
  )
}
