import { Box, Text, useInput } from "ink"

import type { FrontierNode, StepBarrier } from "../../run/schema"
import { Divider } from "./divider"
import { matchesShortcut } from "./input"

function formatFrontierLabel(node: FrontierNode): string {
  const suffix = node.cwd ? ` cwd=${node.cwd}` : ""
  return `${node.user_id ?? node.node_path} [${node.node_kind}]${suffix}`
}

export function BarrierPrompt({
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

  return (
    <Box flexDirection="column">
      <Divider label="Action required" color="cyan" />
      {barrier.next.length <= 1 ? (
        <Text>
          {"  Next: "}
          {barrier.next[0] === undefined ? "(none)" : formatFrontierLabel(barrier.next[0])}
        </Text>
      ) : (
        <Box flexDirection="column">
          <Text>{"  Next:"}</Text>
          {barrier.next.map((node) => (
            <Text key={node.node_path}>
              {"  "}
              {formatFrontierLabel(node)}
            </Text>
          ))}
        </Box>
      )}
      <Text />
      <Text>
        {"  "}
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
