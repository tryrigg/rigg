import figures from "figures"

import type { RunStatus } from "../session/schema"
import type { RecordingStatus } from "./history.sql"
import type { Run, RunLog, RunSummary, StepLog } from "./query"

const ANSI = {
  dim: "\u001B[2m",
  green: "\u001B[32m",
  red: "\u001B[31m",
  yellow: "\u001B[33m",
  reset: "\u001B[0m",
} as const

type ListRow = {
  lastRun: RunSummary | null
  stepCount: number
  workflowId: string
}

function colorsEnabled(stdout: NodeJS.WriteStream = process.stdout): boolean {
  return Boolean(stdout.isTTY) && process.env["NO_COLOR"] === undefined
}

function colorize(value: string, color: keyof typeof ANSI, enabled: boolean): string {
  if (!enabled) {
    return value
  }

  return `${ANSI[color]}${value}${ANSI.reset}`
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, "")
}

function visibleLength(value: string): number {
  return stripAnsi(value).length
}

function cutVisible(value: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return ""
  }

  let out = ""
  let seen = 0

  for (let index = 0; index < value.length; ) {
    const ansi = /^\u001B\[[0-9;]*m/.exec(value.slice(index))
    if (ansi) {
      out += ansi[0]
      index += ansi[0].length
      continue
    }

    const point = value.codePointAt(index)
    if (point === undefined) {
      break
    }
    if (seen >= maxWidth) {
      break
    }

    const char = String.fromCodePoint(point)
    out += char
    seen += 1
    index += char.length
  }

  return out
}

function truncate(value: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return ""
  }
  if (visibleLength(value) <= maxWidth) {
    return value
  }
  if (maxWidth === 1) {
    return "…"
  }
  return `${cutVisible(value, maxWidth - 1)}…`
}

function pad(value: string, width: number): string {
  const deficit = width - visibleLength(value)
  return deficit > 0 ? `${value}${" ".repeat(deficit)}` : value
}

function fitWidths(widths: number[], max: number): number[] {
  const next = [...widths]
  let total = next.reduce((sum, item) => sum + item, 0)

  while (total > max) {
    const index = next.reduce((best, item, i) => (item > (next[best] ?? item) ? i : best), 0)
    const current = next[index]
    if (current === undefined || current === 1) {
      return next
    }
    next[index] = current - 1
    total -= 1
  }

  return next
}

function table(
  headers: string[],
  rows: string[][],
  width = process.stdout.columns ?? 80,
  color = colorsEnabled(),
): string[] {
  if (rows.length === 0) {
    return []
  }

  const columnWidths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => visibleLength(row[index] ?? ""))),
  )
  const max = width - 1 - (headers.length - 1) * 3
  const widths = max > 0 ? fitWidths(columnWidths, max) : columnWidths.map(() => 1)

  const headerLine = ` ${headers
    .map((header, index) => pad(truncate(header, widths[index] ?? header.length), widths[index] ?? header.length))
    .join("   ")}`

  const lines = [colorize(headerLine, "dim", color)]
  for (const row of rows) {
    lines.push(
      ` ${row
        .map((cell, index) =>
          pad(truncate(cell, widths[index] ?? visibleLength(cell)), widths[index] ?? visibleLength(cell)),
        )
        .join("   ")}`,
    )
  }

  return lines
}

export function formatDurationText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) {
    return "—"
  }
  if (ms < 1000) {
    return `${ms}ms`
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`
  }
  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000)
    const seconds = Math.floor((ms % 60_000) / 1000)
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s`
  }

  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  return `${hours}h ${minutes}m`
}

export function formatRelativeTime(value: string, now = new Date()): string {
  const then = new Date(value)
  const diffMs = now.getTime() - then.getTime()
  if (diffMs < 60_000) {
    return "just now"
  }

  const diffMinutes = Math.floor(diffMs / 60_000)
  const diffHours = Math.floor(diffMs / 3_600_000)
  const diffDays = Math.floor(diffMs / 86_400_000)

  if (diffMinutes === 1) {
    return "1 minute ago"
  }
  if (diffMinutes < 60) {
    return `${diffMinutes} minutes ago`
  }
  if (diffHours === 1) {
    return "1 hour ago"
  }
  if (diffHours < 24) {
    return `${diffHours} hours ago`
  }
  if (diffDays === 1) {
    return "yesterday"
  }
  return `${diffDays} days ago`
}

export function formatAbsoluteTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
  }).format(new Date(value))
}

function statusToken(status: string, color = colorsEnabled()): string {
  switch (status) {
    case "succeeded":
      return `${colorize(figures.tick, "green", color)} succeeded`
    case "failed":
      return `${colorize(figures.cross, "red", color)} failed`
    case "aborted":
      return `${colorize(figures.warning, "yellow", color)} aborted`
    case "skipped":
      return `${figures.circleDotted} skipped`
    case "running":
      return `${figures.circle} running`
    default:
      return `${figures.circle} ${status}`
  }
}

function stepStatusIcon(status: string, color = colorsEnabled()): string {
  switch (status) {
    case "succeeded":
      return colorize(figures.tick, "green", color)
    case "failed":
      return colorize(figures.cross, "red", color)
    case "aborted":
    case "interrupted":
      return colorize(figures.warning, "yellow", color)
    case "skipped":
      return figures.circleDotted
    default:
      return figures.circle
  }
}

export function renderNoRuns(): string[] {
  return ["No runs recorded yet. Run a workflow to start tracking history:", "", "  rigg run <workflow_id>"]
}

export function renderNoWorkflowRuns(workflowId: string): string[] {
  return [`No runs found for workflow "${workflowId}".`]
}

export function renderNoFilteredRuns(options: { status: RunStatus; workflowId?: string }): string[] {
  if (options.workflowId !== undefined) {
    return [`No ${options.status} runs found for workflow "${options.workflowId}".`]
  }

  return [`No runs found with status "${options.status}".`]
}

export function renderEmptyHistoryPage(
  offset: number,
  options: { status?: RunStatus; workflowId?: string } = {},
): string[] {
  if (options.workflowId !== undefined && options.status !== undefined) {
    return [`No ${options.status} runs found for workflow "${options.workflowId}" at offset ${offset}.`]
  }
  if (options.workflowId !== undefined) {
    return [`No runs found for workflow "${options.workflowId}" at offset ${offset}.`]
  }
  if (options.status !== undefined) {
    return [`No runs found with status "${options.status}" at offset ${offset}.`]
  }

  return [`No runs found at offset ${offset}.`]
}

export function renderRunNotFound(prefix: string, recent: RunSummary[]): string[] {
  const lines = [`Run "${prefix}" not found.`]
  if (recent.length === 0) {
    return lines
  }

  lines.push("", "Recent runs:")
  for (const run of recent) {
    lines.push(` ${run.shortId}  ${run.workflowId.padEnd(8, " ")} ${formatRelativeTime(run.startedAt)}`)
  }
  lines.push("", "Show details: rigg show <run_id>")
  return lines
}

export function renderAmbiguousPrefix(prefix: string, matches: RunSummary[]): string[] {
  const lines = [`Run prefix "${prefix}" matches ${matches.length} runs:`]
  for (const run of matches) {
    lines.push(` ${run.shortId}  ${run.workflowId.padEnd(8, " ")} ${formatRelativeTime(run.startedAt)}`)
  }
  lines.push("", "Use a longer prefix to disambiguate.")
  return lines
}

function formatStepRef(step: { nodePath: string; userId: string | null }): string {
  if (step.userId === null) {
    return step.nodePath
  }
  return `${step.userId} (${step.nodePath})`
}

function formatAttemptSuffix(step: { attempt: number }): string {
  return step.attempt > 1 ? ` [attempt ${step.attempt}]` : ""
}

function formatStepLabel(step: { attempt: number; nodePath: string; userId: string | null }): string {
  return `${step.userId ?? step.nodePath}${formatAttemptSuffix(step)}`
}

export function renderAmbiguousStep(
  step: string,
  run: string,
  matches: Array<{ nodePath: string; userId: string | null }>,
): string[] {
  return [
    `Step selector "${step}" matches ${matches.length} steps in run ${run}.`,
    "",
    "Use a node path to disambiguate:",
    ...matches.map((match) => `  ${formatStepRef(match)}`),
  ]
}

export function renderMissingStep(
  step: string,
  run: string,
  steps: Array<{ nodePath: string; userId: string | null }>,
): string[] {
  const names = [...new Set(steps.map(formatStepRef))]
  return [
    `Step "${step}" not found in run ${run}.`,
    "",
    "Steps in this run:",
    names.length === 0 ? "  (none)" : `  ${names.join(", ")}`,
  ]
}

export function renderHistory(items: RunSummary[], now = new Date(), color = colorsEnabled()): string[] {
  return table(
    ["STATUS", "WORKFLOW", "DURATION", "WHEN", "RUN"],
    items.map((item) => [
      statusToken(item.status, color),
      item.workflowId,
      formatDurationText(item.durationMs),
      formatRelativeTime(item.startedAt, now),
      item.shortId,
    ]),
    process.stdout.columns ?? 80,
    color,
  )
}

function rule(width = process.stdout.columns ?? 58): string {
  return "─".repeat(Math.max(1, width))
}

function alignLeftRight(left: string, right: string, width = process.stdout.columns ?? 80): string {
  const gap = Math.max(2, width - visibleLength(left) - visibleLength(right))
  return `${left}${" ".repeat(gap)}${right}`
}

const SUMMARY_STATUS = [
  { color: "green", icon: figures.tick, key: "succeeded", label: "succeeded" },
  { color: "red", icon: figures.cross, key: "failed", label: "failed" },
  { color: "yellow", icon: figures.warning, key: "interrupted", label: "interrupted" },
  { color: null, icon: figures.circleDotted, key: "skipped", label: "skipped" },
  { color: null, icon: figures.circle, key: "running", label: "running" },
  { color: null, icon: figures.circle, key: "pending", label: "pending" },
] as const

function renderSummaryCounts(run: Run, color = colorsEnabled()): string {
  const counts = new Map<string, number>()
  for (const step of run.steps) {
    counts.set(step.status, (counts.get(step.status) ?? 0) + 1)
  }

  const hasAny = SUMMARY_STATUS.some((status) => (counts.get(status.key) ?? 0) > 0)
  const left = SUMMARY_STATUS.map((status) => {
    const count = counts.get(status.key) ?? 0
    if (count === 0 && (status.key !== "succeeded" || hasAny)) {
      return null
    }

    const icon = status.color === null ? status.icon : colorize(status.icon, status.color, color)
    return `  ${icon} ${count} ${status.label}`
  })
    .filter((item): item is string => item !== null)
    .join("  ")

  return alignLeftRight(left, formatDurationText(run.durationMs))
}

export function renderRunView(run: Run, color = colorsEnabled()): string[] {
  const lines = [
    alignLeftRight(
      `▸ rigg · ${run.workflowId} · ${run.shortId}`,
      `${formatDurationText(run.durationMs)}  ${run.status}`,
    ),
    rule(),
  ]

  for (const step of run.steps) {
    const label = formatStepLabel(step)
    const left = `  ${stepStatusIcon(step.status, color)} ${label}  (${step.nodeKind})`
    lines.push(alignLeftRight(left, formatDurationText(step.durationMs)))
  }

  lines.push(
    rule(),
    renderSummaryCounts(run, color),
    "",
    `  ${run.status.charAt(0).toUpperCase()}${run.status.slice(1)}  ${run.reason ?? ""}`.trimEnd(),
    "",
    `  run ${run.shortId} · ${formatAbsoluteTime(run.startedAt)}`,
  )
  return lines
}

function pushBordered(lines: string[], text: string): void {
  const rows = text.replace(/\r\n?/g, "\n").split("\n")
  if (rows.at(-1) === "") {
    rows.pop()
  }
  for (const rawLine of rows) {
    lines.push(`│ ${rawLine}`)
  }
}

function trimTrailingEol(text: string): string {
  return text.replace(/[\r\n]+$/u, "")
}

function appendOutput(
  output: Array<{ text: string; stream: string | null }>,
  stream: "stdout" | "stderr",
  text: string | null,
  seen?: string,
): void {
  if (text === null || text === "") {
    return
  }

  const prior =
    seen ??
    output
      .filter((entry) => entry.stream === stream)
      .map((entry) => entry.text)
      .join("")
  if (trimTrailingEol(prior) === trimTrailingEol(text)) {
    return
  }
  if (prior !== "" && text.startsWith(prior)) {
    const suffix = text.slice(prior.length)
    const last = output.at(-1)
    if (last?.stream === stream) {
      last.text += suffix
      return
    }
    output.push({ stream, text: suffix })
    return
  }

  output.push({ stream, text })
}

function logEntries(step: StepLog): Array<{ text: string; stream: string | null }> {
  const output: Array<{ text: string; stream: string | null }> = []
  output.push(
    ...step.entries
      .filter((entry) => hasText(entry.text))
      .map((entry) => ({ stream: entry.stream, text: entry.text ?? "" })),
  )
  const stdoutSeen = step.entries
    .filter((entry) => hasText(entry.text) && (entry.stream === "stdout" || entry.kind === "assistant"))
    .map((entry) => entry.text ?? "")
    .join("")
  appendOutput(output, "stdout", step.stdoutPreview, stdoutSeen === "" ? undefined : stdoutSeen)
  appendOutput(output, "stderr", step.stderrPreview)
  return output
}

function hasText(text: string | null): boolean {
  return text !== null && text !== ""
}

export function hasStepOutput(step: StepLog): boolean {
  return logEntries(step).length > 0 || step.stdoutPath !== null || step.stderrPath !== null
}

export function hasLogOutput(run: RunLog): boolean {
  if (run.runEntries.some((entry) => hasText(entry.text))) {
    return true
  }
  return run.steps.some((step) => hasStepOutput(step))
}

function eventEntries(entries: RunLog["runEntries"]): Array<{ text: string; stream: string | null }> {
  return entries
    .filter((entry) => hasText(entry.text))
    .map((entry) => ({ stream: entry.stream, text: entry.text ?? "" }))
}

function noOutputMessage(runId: string, recordingStatus: RecordingStatus, step?: string): string[] {
  if (recordingStatus === "partial") {
    if (step === undefined) {
      return [`Run ${runId} was only partially recorded, and no output is available.`]
    }
    return [`Run ${runId} was only partially recorded, and no output is available for step "${step}".`]
  }

  if (step === undefined) {
    return [`No output recorded for run ${runId}.`]
  }
  return [`No output recorded for step "${step}" in run ${runId}.`]
}

export function renderNoStepOutput(step: string, runId: string, recordingStatus: RecordingStatus): string[] {
  return noOutputMessage(runId, recordingStatus, step)
}

export function renderNoRunOutput(runId: string, recordingStatus: RecordingStatus): string[] {
  return noOutputMessage(runId, recordingStatus)
}

export function renderLogView(run: RunLog, color = colorsEnabled()): string[] {
  const lines: string[] = []
  const runEntries = eventEntries(run.runEntries)
  if (runEntries.length > 0) {
    lines.push(alignLeftRight("▸ run", `${formatDurationText(run.durationMs)}  ${run.status}`), rule())
    for (const entry of runEntries) {
      pushBordered(lines, entry.text)
    }
  }

  for (const step of run.steps) {
    const entries = logEntries(step)
    if (entries.length === 0 && step.stdoutPath === null && step.stderrPath === null) {
      continue
    }
    if (lines.length > 0) {
      lines.push("")
    }

    lines.push(
      alignLeftRight(
        `▸ ${formatStepLabel(step)} (${step.nodeKind})`,
        `${formatDurationText(step.durationMs)}  ${step.status}`,
      ),
      rule(),
    )

    for (const entry of entries) {
      pushBordered(lines, entry.text)
    }
    if (step.stdoutPath !== null) {
      lines.push(`│ … stdout truncated; full output saved to ${step.stdoutPath}`)
    }
    if (step.stderrPath !== null) {
      lines.push(`│ … stderr truncated; full output saved to ${step.stderrPath}`)
    }
  }

  return lines
}

export function renderWorkflowList(rows: ListRow[], now = new Date(), color = colorsEnabled()): string[] {
  return table(
    ["WORKFLOW", "STEPS", "LAST RUN", "STATUS"],
    rows.map((row) => [
      row.workflowId,
      String(row.stepCount),
      row.lastRun === null ? "—" : formatRelativeTime(runTime(row.lastRun), now),
      row.lastRun === null ? "—" : statusToken(row.lastRun.status, color),
    ]),
    process.stdout.columns ?? 80,
    color,
  )
}

function runTime(run: RunSummary): string {
  if (run.finishedAt !== null) {
    return run.finishedAt
  }
  return run.startedAt
}
