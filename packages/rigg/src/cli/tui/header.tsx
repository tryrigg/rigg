import { Box, Text, useStdout } from "ink"

import type { RunSnapshot, RunStatus } from "../../run/schema"
import type { BarrierApprovalMode } from "../run"
import { layoutHeaderLine, renderRule } from "./layout"

function statusColor(status: RunStatus | string): string {
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

function statusLabel(snapshot: RunSnapshot, barrierMode: BarrierApprovalMode): string {
  if (snapshot.active_interaction !== null) {
    return "waiting for input"
  }
  if (snapshot.active_barrier !== null && barrierMode === "manual") {
    return "waiting for approval"
  }
  return snapshot.status
}

export function Header({
  barrierMode,
  snapshot,
  elapsed,
  stepProgress,
}: {
  barrierMode: BarrierApprovalMode
  snapshot: RunSnapshot | null
  elapsed: string
  stepProgress?: string | undefined
}) {
  const { stdout } = useStdout()
  const cols = stdout?.columns ?? 80

  if (snapshot === null) {
    const layout = layoutHeaderLine({
      cols,
      elapsed: "",
      status: "waiting",
      workflowId: "",
    })

    return (
      <Box flexDirection="column">
        <Text>
          {layout.left.length > 0 && <Text bold>{layout.left}</Text>}
          {" ".repeat(layout.gap)}
          <Text dimColor>{layout.statusText}</Text>
        </Text>
        <Text dimColor>{renderRule(cols)}</Text>
      </Box>
    )
  }

  const status = statusLabel(snapshot, barrierMode)
  const color = statusColor(status)
  const layout = layoutHeaderLine({
    cols,
    elapsed,
    status,
    stepProgress,
    workflowId: snapshot.workflow_id,
  })

  return (
    <Box flexDirection="column">
      <Text>
        {layout.left.length > 0 && <Text bold>{layout.left}</Text>}
        {" ".repeat(layout.gap)}
        {layout.elapsedText.length > 0 && <Text dimColor>{layout.elapsedText} </Text>}
        <Text bold color={color}>
          {layout.statusText}
        </Text>
      </Text>
      <Text dimColor>{renderRule(cols)}</Text>
    </Box>
  )
}
