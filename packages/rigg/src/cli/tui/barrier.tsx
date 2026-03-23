import { Box, Text, useInput } from "ink"

import type { StepBarrier } from "../../session/schema"
import { frontierLabel } from "../state"
import { matchesShortcut } from "./input"
import { statusSymbol } from "./symbols"

export function Barrier({
  barrier,
  onResolve,
}: {
  barrier: StepBarrier
  onResolve: (action: "abort" | "continue") => void
}) {
  useInput((input, key) => {
    if (matchesShortcut(input, key, "c")) {
      onResolve("continue")
    } else if (matchesShortcut(input, key, "a")) {
      onResolve("abort")
    }
  })

  const completedInfo = barrier.completed
  const completedSym = completedInfo ? statusSymbol(completedInfo.status) : null

  return (
    <Box flexDirection="column">
      {completedInfo != null && completedSym != null && (
        <Text dimColor>
          <Text color={completedSym.color}>{completedSym.icon}</Text> {completedInfo.user_id ?? completedInfo.node_path}{" "}
          {completedInfo.status}
        </Text>
      )}
      <Text>Next: {barrier.next.length === 0 ? "(none)" : frontierLabel(barrier.next[0]!)}</Text>
      {barrier.next.length > 1 &&
        barrier.next.slice(1).map((node) => (
          <Text key={node.node_path} dimColor>
            {"  "}
            {frontierLabel(node)}
          </Text>
        ))}
      <Text>{""}</Text>
      <Text>
        <Text bold color="cyan">
          [c]
        </Text>{" "}
        continue{"  "}
        <Text bold color="red">
          [a]
        </Text>{" "}
        abort
      </Text>
    </Box>
  )
}
