import { Box, Text, useStdout } from "ink"
import Spinner from "ink-spinner"
import { useMemo } from "react"

import type { NodeStatus } from "../../run/schema"
import type { ActiveLiveOutput, CompletedOutput, LiveLogEntry, OutputPreview } from "../run"
import { statusSymbol, kindTag } from "./symbols"
import type { TreeEntry } from "./tree"

const KIND_LABELS: Record<string, string> = { shell: "cmd", codex: "action", write_file: "file" }
const BASE = "  "

type FlatLine = { muted: boolean; text: string }

function flattenEntriesToLines(entries: LiveLogEntry[], options: { labelStderr: boolean }): FlatLine[] {
  const lines: FlatLine[] = []
  for (const entry of entries) {
    const entryLines = entry.text.replace(/\r\n?/g, "\n").split("\n").filter(Boolean)
    for (const [index, line] of entryLines.entries()) {
      if (entry.variant === "event") {
        lines.push({ muted: true, text: `[${line}]` })
        continue
      }

      if (entry.variant === "stream" && entry.stream === "stderr" && options.labelStderr) {
        const prefix = index === 0 ? "stderr: " : ""
        lines.push({ muted: false, text: `${prefix}${line}` })
        continue
      }

      lines.push({ muted: false, text: line })
    }
  }
  return lines
}

function liveOutputToLines(live: ActiveLiveOutput | undefined): FlatLine[] | null {
  if (live === undefined) {
    return null
  }

  const lines = flattenEntriesToLines(live.entries, { labelStderr: false })
  return lines.length > 0 ? lines : null
}

export function countRenderableLiveOutputs(liveOutputs: Record<string, ActiveLiveOutput>): number {
  let count = 0
  for (const live of Object.values(liveOutputs)) {
    if (liveOutputToLines(live) !== null) {
      count++
    }
  }
  return count
}

function previewToLines(preview: OutputPreview | null): FlatLine[] {
  if (preview === null) {
    return []
  }

  return preview.text
    .split("\n")
    .filter(Boolean)
    .map((text, index) => ({
      muted: false,
      text: preview.stream === "stderr" && index === 0 ? `stderr: ${text}` : text,
    }))
}

export function completedOutputToLines(completed: CompletedOutput | undefined): FlatLine[] | null {
  if (completed === undefined) {
    return null
  }

  const lines = flattenEntriesToLines(completed.entries, { labelStderr: true })
  const previewLines = previewToLines(completed.preview)
  if (lines.length === 0 && previewLines.length === 0) {
    return null
  }
  if (lines.length === 0) {
    return previewLines
  }

  const merged = [...lines]
  const uniquePreviewLines = previewLines.filter(
    (previewLine) =>
      !merged.some((candidate) => candidate.text === previewLine.text && candidate.muted === previewLine.muted),
  )
  for (const previewLine of uniquePreviewLines) {
    merged.push(previewLine)
  }

  return merged.length > 0 ? merged.slice(-2) : null
}

function InlineOutput({
  nodePath,
  status,
  prefix,
  liveOutputs,
  completedOutputs,
  maxLiveLines,
}: {
  nodePath: string
  status: NodeStatus | "not_started"
  prefix: string
  liveOutputs: Record<string, ActiveLiveOutput>
  completedOutputs: Record<string, CompletedOutput>
  maxLiveLines: number
}) {
  const pad = BASE + prefix + "   "

  const completed = completedOutputs[nodePath]
  const completedLines = useMemo(() => {
    return completedOutputToLines(completed)
  }, [completed])

  if (status === "running") {
    const lines = liveOutputToLines(liveOutputs[nodePath])
    if (lines === null) {
      return null
    }
    const visible = lines.slice(-maxLiveLines)
    return (
      <Box flexDirection="column">
        <Text dimColor>{pad}output</Text>
        {visible.map((line, i) => (
          <Text key={i} wrap="truncate-end" dimColor={line.muted}>
            {pad}│ {line.text}
          </Text>
        ))}
      </Box>
    )
  }

  if (completedLines !== null && completedLines.length > 0) {
    return (
      <Box flexDirection="column">
        {completedLines.map((line, i) => (
          <Text key={i} dimColor wrap="truncate-end">
            {pad}│ {line.text}
          </Text>
        ))}
      </Box>
    )
  }

  return null
}

function StepRow({ entry }: { entry: TreeEntry }) {
  const sym = statusSymbol(entry.status)
  const kt = kindTag(entry.nodeKind)
  const showKind = entry.nodeKind !== entry.label

  return (
    <Box>
      <Text>
        {BASE}
        {entry.prefix}
        <Text color={sym.color}>{sym.icon}</Text>
        {"  "}
        {entry.label}
        {showKind && (
          <Text dimColor>
            {"  "}
            {kt.icon} <Text bold>{entry.nodeKind}</Text>
          </Text>
        )}
        {entry.suffix ? (
          <Text dimColor>
            {"  "}
            {entry.suffix}
          </Text>
        ) : null}
        {entry.meta ? (
          <Text dimColor>
            {"  "}
            {entry.meta}
          </Text>
        ) : null}
      </Text>
      {entry.isActive && (
        <Text color="cyan">
          {"  "}
          <Spinner type="dots" />
        </Text>
      )}
      {entry.isNext && <Text dimColor>{"  next"}</Text>}
    </Box>
  )
}

function DetailLine({ entry }: { entry: TreeEntry }) {
  if (!entry.detail) {
    return null
  }
  if (entry.status === "succeeded" || entry.status === "failed") {
    return null
  }
  const label = KIND_LABELS[entry.nodeKind]
  return (
    <Text dimColor>
      {BASE}
      {entry.prefix}
      {"   "}
      {label && <Text bold>{label} </Text>}
      {entry.detail}
    </Text>
  )
}

function BoxBorder({ entry, char, cols }: { entry: TreeEntry; char: string; cols: number }) {
  const labelStr = entry.boxLabel ? `── ${entry.boxLabel} ` : ""
  const fill = cols - BASE.length - entry.prefix.length - 1 - labelStr.length
  return (
    <Text key={entry.nodePath} dimColor>
      {BASE}
      {entry.prefix}
      {char}
      {entry.boxLabel ? (
        <>
          ── <Text bold>{entry.boxLabel}</Text>{" "}
        </>
      ) : (
        ""
      )}
      {"─".repeat(Math.max(0, fill))}
    </Text>
  )
}

export function WorkflowTree({
  entries,
  liveOutputs,
  completedOutputs,
}: {
  entries: TreeEntry[]
  liveOutputs: Record<string, ActiveLiveOutput>
  completedOutputs: Record<string, CompletedOutput>
}) {
  const { stdout } = useStdout()
  const cols = stdout?.columns ?? 80

  if (entries.length === 0) {
    return null
  }

  const activeCount = countRenderableLiveOutputs(liveOutputs)
  const maxLiveLines = activeCount > 1 ? Math.max(3, Math.floor(16 / activeCount)) : 8

  return (
    <Box flexDirection="column">
      {entries.map((entry, i) => {
        switch (entry.entryType) {
          case "box_open":
            return <BoxBorder key={entry.nodePath} entry={entry} char="╭" cols={cols} />
          case "box_divider":
            return <BoxBorder key={entry.nodePath} entry={entry} char="├" cols={cols} />
          case "box_close": {
            const fill = cols - BASE.length - entry.prefix.length - 1
            return (
              <Text key={entry.nodePath} dimColor>
                {BASE}
                {entry.prefix}╰{"─".repeat(Math.max(0, fill))}
              </Text>
            )
          }
          case "step": {
            const isTopLevel = entry.depth === 0
            const prevEntry = i > 0 ? entries[i - 1] : undefined
            const needsSpace = isTopLevel && prevEntry !== undefined && prevEntry.entryType !== "box_open"
            return (
              <Box key={entry.nodePath} flexDirection="column">
                {needsSpace && <Text>{""}</Text>}
                <StepRow entry={entry} />
                <DetailLine entry={entry} />
                <InlineOutput
                  nodePath={entry.nodePath}
                  status={entry.status}
                  prefix={entry.prefix}
                  liveOutputs={liveOutputs}
                  completedOutputs={completedOutputs}
                  maxLiveLines={maxLiveLines}
                />
              </Box>
            )
          }
        }
      })}
    </Box>
  )
}
