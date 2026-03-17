import { Box, Text, useStdout } from "ink"

import { renderRule } from "./layout"

export function Divider({ label, color }: { label: string; color?: string }) {
  const { stdout } = useStdout()
  const cols = stdout?.columns ?? 80
  const linePrefix = "--- "
  const lineSuffix = " "
  const rule = renderRule(cols, "")
  const remaining = Math.max(0, rule.length - linePrefix.length - label.length - lineSuffix.length)
  const textProps = color ? { dimColor: true as const, color } : { dimColor: true as const }
  return (
    <Box>
      <Text {...textProps}>
        {linePrefix}
        <Text bold>{label}</Text>
        {lineSuffix}
        {"-".repeat(remaining)}
      </Text>
    </Box>
  )
}
