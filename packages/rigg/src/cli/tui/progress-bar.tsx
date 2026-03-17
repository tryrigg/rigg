import { Text, useStdout } from "ink"

import { chars } from "./theme"

export function ProgressBar({ completed, total }: { completed: number; total: number }) {
  const { stdout } = useStdout()
  const cols = stdout?.columns ?? 80
  const label = ` ${completed}/${total}`
  const barWidth = Math.max(0, cols - 4 - label.length)
  const filledWidth = total > 0 ? Math.round((completed / total) * barWidth) : 0
  const emptyWidth = barWidth - filledWidth

  return (
    <Text>
      {"  "}
      <Text color="cyan">{chars.progressFilled.repeat(filledWidth)}</Text>
      <Text dimColor>{chars.progressEmpty.repeat(emptyWidth)}</Text>
      <Text dimColor>{label}</Text>
    </Text>
  )
}
