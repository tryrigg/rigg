import { Box, Text, useStdout } from "ink"

import type { RunSnapshot } from "../../run/schema"
import { renderRule } from "./layout"
import { formatDuration, statusSymbol } from "./symbols"
import { runDurationMs } from "./time"
import { SUMMARY_KINDS, type TreeEntry } from "./tree"

export function countSummaryStatuses(entries: TreeEntry[]): {
  failedCount: number
  failedSteps: Array<{ label: string; suffix: string }>
  interruptedCount: number
  skippedCount: number
  succeededCount: number
} {
  let failedCount = 0
  let interruptedCount = 0
  let skippedCount = 0
  let succeededCount = 0
  const failedSteps: Array<{ label: string; suffix: string }> = []

  for (const entry of entries) {
    if (entry.entryType !== "step" || !SUMMARY_KINDS.has(entry.nodeKind)) {
      continue
    }
    switch (entry.status) {
      case "failed":
        failedCount++
        failedSteps.push({ label: entry.label, suffix: entry.suffix })
        break
      case "interrupted":
        interruptedCount++
        break
      case "skipped":
        skippedCount++
        break
      case "succeeded":
        succeededCount++
        break
    }
  }

  return { failedCount, failedSteps, interruptedCount, skippedCount, succeededCount }
}

export function Summary({ snapshot, entries }: { snapshot: RunSnapshot | null; entries: TreeEntry[] }) {
  if (snapshot === null) {
    return null
  }

  const { stdout } = useStdout()
  const cols = stdout?.columns ?? 80

  const { failedCount, failedSteps, interruptedCount, skippedCount, succeededCount } = countSummaryStatuses(entries)
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
              {succeededSym.icon} {succeededCount} succeeded
            </Text>
            {failedCount > 0 && (
              <Text color={failedSym.color}>
                {"  "}
                {failedSym.icon} {failedCount} failed
              </Text>
            )}
            {interruptedCount > 0 && (
              <Text color={interruptedSym.color}>
                {"  "}
                {interruptedSym.icon} {interruptedCount} interrupted
              </Text>
            )}
            {skippedCount > 0 && (
              <Text color={skippedSym.color}>
                {"  "}
                {skippedSym.icon} {skippedCount} skipped
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
      {failedSteps.length > 0 && <Text>{""}</Text>}
      {failedSteps.length > 0 &&
        failedSteps.map((step, i) => (
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
    </Box>
  )
}
