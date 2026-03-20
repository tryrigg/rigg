import { Box, Text } from "ink"
import Spinner from "ink-spinner"
import { useMemo } from "react"

import type { NodeStatus } from "../../session/schema"
import type { ActiveLiveOutput, CompletedOutput, LiveLogEntry, OutputPreview } from "../state"
import { statusSymbol, kindColor } from "./symbols"
import { chars, colors } from "./theme"
import type { TreeEntry } from "./tree"

const KIND_LABELS: Record<string, string> = {
  shell: "cmd",
  codex: "codex",
  write_file: "write_file",
  group: "group",
  loop: "loop",
  workflow: "workflow",
  parallel: "parallel",
  branch: "branch",
  branch_case: "case",
}
const BASE = "  "

type FlatLine = { isStderr: boolean; muted: boolean; text: string }

function isSameFlatLine(a: FlatLine, b: FlatLine): boolean {
  return a.isStderr === b.isStderr && a.muted === b.muted && a.text === b.text
}

function flattenEntriesToLines(entries: LiveLogEntry[], options: { labelStderr: boolean }): FlatLine[] {
  const lines: FlatLine[] = []
  for (const entry of entries) {
    const entryLines = entry.text.replace(/\r\n?/g, "\n").split("\n").filter(Boolean)
    const isStderr = entry.variant === "stream" && entry.stream === "stderr"
    for (const [index, line] of entryLines.entries()) {
      if (entry.variant === "event") {
        lines.push({ isStderr: false, muted: true, text: `[${line}]` })
        continue
      }

      if (isStderr && options.labelStderr) {
        const prefix = index === 0 ? "stderr: " : ""
        lines.push({ isStderr: true, muted: false, text: `${prefix}${line}` })
        continue
      }

      lines.push({ isStderr, muted: false, text: line })
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

export function countLiveOutputs(liveOutputs: Record<string, ActiveLiveOutput>): number {
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

  const isStderr = preview.stream === "stderr"
  return preview.text
    .split("\n")
    .filter(Boolean)
    .map((text: string, index: number) => ({
      isStderr,
      muted: false,
      text: isStderr && index === 0 ? `stderr: ${text}` : text,
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
    (previewLine) => !merged.some((candidate) => isSameFlatLine(candidate, previewLine)),
  )
  for (const previewLine of uniquePreviewLines) {
    merged.push(previewLine)
  }

  return merged.length > 0 ? merged.slice(-2) : null
}

function computeHasNextSibling(entries: TreeEntry[]): boolean[] {
  const result = new Array<boolean>(entries.length).fill(false)
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    if (entry.entryType !== "step") continue
    for (let j = i + 1; j < entries.length; j++) {
      const next = entries[j]!
      if (next.depth < entry.depth) break
      if (next.depth === entry.depth && next.entryType === "step") {
        result[i] = true
        break
      }
    }
  }
  return result
}

function connectorColor(status: NodeStatus | "not_started"): string | undefined {
  switch (status) {
    case "succeeded":
      return colors.success
    case "failed":
      return colors.error
    case "skipped":
    case "interrupted":
      return undefined
    case "running":
      return colors.brand
    case "waiting_for_interaction":
      return colors.warning
    default:
      return undefined
  }
}

type EntryColors = {
  prefixRailColors: (string | undefined)[]
  railColor: string | undefined
}

function computeEntryColors(entries: TreeEntry[]): EntryColors[] {
  const statusAtDepth = new Map<number, NodeStatus | "not_started">()
  return entries.map((entry) => {
    if (entry.entryType === "step") {
      statusAtDepth.set(entry.depth, entry.status)
    }
    const prefixRailColors: (string | undefined)[] = []
    let depth = 0
    for (let i = 0; i < entry.prefix.length; i++) {
      if (entry.prefix[i] === "│") {
        const ancestorStatus = statusAtDepth.get(depth)
        prefixRailColors.push(ancestorStatus !== undefined ? connectorColor(ancestorStatus) : undefined)
        depth++
      }
    }
    const railColor = entry.entryType === "step" ? connectorColor(entry.status) : undefined
    return { prefixRailColors, railColor }
  })
}

function renderColoredRails(text: string, railColors: (string | undefined)[]) {
  if (text.length === 0) return null
  if (railColors.length === 0) return <Text dimColor>{text}</Text>

  const parts: React.ReactNode[] = []
  let railIdx = 0
  let segStart = 0

  for (let i = 0; i < text.length; i++) {
    if (text[i] === "│" && railIdx < railColors.length) {
      if (i > segStart) {
        parts.push(
          <Text key={`s${segStart}`} dimColor>
            {text.slice(segStart, i)}
          </Text>,
        )
      }
      const color = railColors[railIdx]
      parts.push(
        color ? (
          <Text key={`r${railIdx}`} color={color}>
            │
          </Text>
        ) : (
          <Text key={`r${railIdx}`} dimColor>
            │
          </Text>
        ),
      )
      railIdx++
      segStart = i + 1
    }
  }

  if (segStart < text.length) {
    parts.push(
      <Text key="e" dimColor>
        {text.slice(segStart)}
      </Text>,
    )
  }

  return <>{parts}</>
}

function OutputLine({ line, border, alwaysDim }: { line: FlatLine; border: string; alwaysDim?: boolean }) {
  const dim = alwaysDim ?? line.muted
  return line.isStderr ? (
    <Text dimColor={dim} color="red">
      {border} {line.text}
    </Text>
  ) : (
    <Text dimColor={dim}>
      {border} {line.text}
    </Text>
  )
}

function InlineOutput({
  nodePath,
  status,
  prefix,
  rail,
  railColors,
  liveOutputs,
  completedOutputs,
  maxLiveLines,
}: {
  nodePath: string
  status: NodeStatus | "not_started"
  prefix: string
  rail: string
  railColors: (string | undefined)[]
  liveOutputs: Record<string, ActiveLiveOutput>
  completedOutputs: Record<string, CompletedOutput>
  maxLiveLines: number
}) {
  const pad = BASE + prefix + rail

  const completed = completedOutputs[nodePath]
  const completedLines = useMemo(() => {
    return completedOutputToLines(completed)
  }, [completed])

  if (status === "running") {
    const lines = liveOutputToLines(liveOutputs[nodePath])
    if (lines === null) {
      return null
    }
    const truncated = lines.length - maxLiveLines
    const visible = lines.slice(-maxLiveLines)
    return (
      <Box flexDirection="column">
        {visible.map((line, i) => (
          <Text key={i} wrap="truncate-end">
            {renderColoredRails(pad, railColors)}
            <OutputLine line={line} border={chars.outputBorderLive} />
          </Text>
        ))}
        {truncated > 0 && (
          <Text>
            {renderColoredRails(pad, railColors)}
            <Text dimColor>
              {chars.outputBorderLive} +{truncated} more lines
            </Text>
          </Text>
        )}
      </Box>
    )
  }

  if (completedLines !== null && completedLines.length > 0) {
    return (
      <Box flexDirection="column">
        {completedLines.map((line, i) => (
          <Text key={i} wrap="truncate-end">
            {renderColoredRails(pad, railColors)}
            <OutputLine line={line} border={chars.outputBorderDone} alwaysDim />
          </Text>
        ))}
      </Box>
    )
  }

  return null
}

function StepRow({ entry, prefixRailColors }: { entry: TreeEntry; prefixRailColors: (string | undefined)[] }) {
  const sym = statusSymbol(entry.status)
  const kc = kindColor(entry.nodeKind)
  const kindLabel = KIND_LABELS[entry.nodeKind]
  const showKind = kindLabel !== undefined && entry.nodeKind !== entry.label
  const isRunningStatus = entry.status === "running"
  const isWaiting = entry.status === "waiting_for_interaction"
  const isActive = isRunningStatus || isWaiting
  const isDimmed = entry.status === "succeeded" || entry.status === "not_started"

  return (
    <Box>
      <Text>
        {BASE}
        {renderColoredRails(entry.prefix, prefixRailColors)}
        <Text color={entry.isNext ? "yellow" : sym.color}>{sym.icon}</Text>
        {"  "}
        {isRunningStatus ? (
          <Text inverse color="cyan">
            {entry.label}
          </Text>
        ) : entry.isNext ? (
          <Text inverse color="yellow">
            {entry.label}
          </Text>
        ) : (
          <Text bold={isActive} dimColor={isDimmed && !isActive}>
            {entry.label}
          </Text>
        )}
        {showKind && (
          <Text color={kc} dimColor={kc === "dim"}>
            {"  "}({kindLabel})
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
            {"  "}[{entry.meta}]
          </Text>
        ) : null}
      </Text>
      {isRunningStatus && entry.isActive && (
        <Text color="cyan">
          {"  "}
          <Spinner type="dots" />
        </Text>
      )}
      {isWaiting && entry.isActive && (
        <Text color="yellow">
          {"  "}
          <Spinner type="dots" /> waiting
        </Text>
      )}
    </Box>
  )
}

function DetailLine({
  entry,
  rail,
  railColors,
}: {
  entry: TreeEntry
  rail: string
  railColors: (string | undefined)[]
}) {
  if (!entry.detail) {
    return null
  }
  if (entry.status === "succeeded" || entry.status === "failed") {
    return null
  }
  return (
    <Text>
      <Text dimColor>{BASE}</Text>
      {renderColoredRails(entry.prefix + rail, railColors)}
      <Text dimColor>{entry.detail}</Text>
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
  if (entries.length === 0) {
    return null
  }

  const activeCount = countLiveOutputs(liveOutputs)
  const maxLiveLines = activeCount > 1 ? Math.max(3, Math.floor(16 / activeCount)) : 8
  const nextSibling = useMemo(() => computeHasNextSibling(entries), [entries])
  const entryColors = useMemo(() => computeEntryColors(entries), [entries])

  return (
    <Box flexDirection="column">
      {entries.map((entry, i) => {
        const ec = entryColors[i]!
        switch (entry.entryType) {
          case "label":
            return (
              <Text key={entry.nodePath}>
                <Text dimColor>{BASE}</Text>
                {renderColoredRails(entry.prefix, ec.prefixRailColors)}
                <Text dimColor>{entry.label}</Text>
              </Text>
            )
          case "step": {
            const hasNext = nextSibling[i] ?? false
            const rail = hasNext ? "│  " : "   "
            const railColors = [...ec.prefixRailColors, ec.railColor]
            const prevEntry = i > 0 ? entries[i - 1] : undefined
            const needsConnector =
              prevEntry !== undefined && prevEntry.entryType === "step" && prevEntry.depth === entry.depth
            const prevStepStatus = prevEntry?.entryType === "step" ? prevEntry.status : undefined
            const cColor = prevStepStatus !== undefined ? connectorColor(prevStepStatus) : undefined
            const connectorStr = BASE + entry.prefix + "│"
            const connectorRailColors = [...ec.prefixRailColors, cColor]
            return (
              <Box key={entry.nodePath} flexDirection="column">
                {needsConnector && <Text>{renderColoredRails(connectorStr, connectorRailColors)}</Text>}
                <StepRow entry={entry} prefixRailColors={ec.prefixRailColors} />
                <DetailLine entry={entry} rail={rail} railColors={railColors} />
                <InlineOutput
                  nodePath={entry.nodePath}
                  status={entry.status}
                  prefix={entry.prefix}
                  rail={rail}
                  railColors={railColors}
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
