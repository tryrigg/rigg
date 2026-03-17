import { Box, Text, useStdout } from "ink"

import type { RunSnapshot, RunStatus } from "../../run/schema"

function statusColor(status: RunStatus | "waiting"): string {
  switch (status) {
    case "running":
      return "cyan"
    case "succeeded":
      return "green"
    case "failed":
    case "aborted":
      return "red"
    default:
      return "cyan"
  }
}

function statusLabel(snapshot: RunSnapshot): RunStatus | "waiting" {
  if (snapshot.active_interaction !== null || snapshot.active_barrier !== null) {
    return "waiting"
  }
  return snapshot.status
}

export function Header({ snapshot, elapsed }: { snapshot: RunSnapshot | null; elapsed: string }) {
  const { stdout } = useStdout()
  const cols = stdout?.columns ?? 80

  if (snapshot === null) {
    return (
      <Box flexDirection="column">
        <Text>
          {"  "}
          <Text bold>rigg</Text>
          <Text dimColor>{"  waiting"}</Text>
        </Text>
        <Text dimColor>{"  " + "─".repeat(Math.max(0, cols - 4))}</Text>
      </Box>
    )
  }

  const status = statusLabel(snapshot)
  const color = statusColor(status)

  return (
    <Box flexDirection="column">
      <Box>
        <Box flexGrow={1}>
          <Text>
            {"  "}
            <Text bold>rigg</Text>
            {"  "}
            {snapshot.workflow_id}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>{elapsed} </Text>
          <Text bold color={color}>
            ● {status}
          </Text>
        </Box>
      </Box>
      <Text dimColor>{"  " + "─".repeat(Math.max(0, cols - 4))}</Text>
    </Box>
  )
}
