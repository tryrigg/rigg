import { createInterface } from "node:readline/promises"

import type { CodexProviderEvent } from "../codex/event"
import type { CodexInteractionRequest } from "../codex/interaction"
import type { RunControlHandler, RunControlResolution, RunEvent } from "../run/progress"
import type { FrontierNode, NodeSnapshot, PendingInteraction, RunSnapshot, StepBarrier } from "../run/schema"

const CLEAR_SCREEN = "\u001b[2J\u001b[H"

type ActiveLiveOutput = {
  entries: LiveLogEntry[]
  nodePath: string
}

type LiveLogEntry = {
  key: string | null
  text: string
  variant: "assistant" | "event" | "stream"
}

type RenderOptions = {
  userInputQuestionIndex?: number
}

export type TerminalUiState = {
  activeLiveOutput: ActiveLiveOutput | null
  lastCompletedNodePath: string | null
  snapshot: RunSnapshot | null
}

export type TerminalRunSession = {
  close: () => void
  emit: (event: RunEvent) => void
  handle: RunControlHandler
}

export function createTerminalUiState(): TerminalUiState {
  return {
    activeLiveOutput: null,
    lastCompletedNodePath: null,
    snapshot: null,
  }
}

export function createTerminalRunSession(input: NodeJS.ReadStream, output: NodeJS.WriteStream): TerminalRunSession {
  const readline = createInterface({
    input,
    output,
    terminal: Boolean(output.isTTY),
  })
  const state = createTerminalUiState()

  function render(options: RenderOptions = {}): void {
    const frame = renderTerminalFrame(state, options)
    if (output.isTTY) {
      output.write(CLEAR_SCREEN)
    }
    output.write(frame)
  }

  function emit(event: RunEvent): void {
    applyRunEvent(state, event)
    render()
  }

  async function handle(request: Parameters<RunControlHandler>[0]): Promise<RunControlResolution> {
    state.snapshot = request.snapshot

    if (request.kind === "step_barrier") {
      render()
      return await promptBarrier(readline)
    }

    if (request.interaction.kind === "user_input") {
      return await promptUserInput(readline, render, request.interaction)
    }

    render()
    return await handleInteraction(readline, render, request.interaction)
  }

  return {
    close: () => readline.close(),
    emit,
    handle,
  }
}

export function applyRunEvent(state: TerminalUiState, event: RunEvent): void {
  switch (event.kind) {
    case "run_started":
      state.activeLiveOutput = null
      state.lastCompletedNodePath = null
      state.snapshot = event.snapshot
      return
    case "node_started":
      state.snapshot = event.snapshot
      state.activeLiveOutput = {
        entries: [],
        nodePath: event.node.node_path,
      }
      return
    case "node_completed":
      state.snapshot = event.snapshot
      state.lastCompletedNodePath = event.node.node_path
      if (state.activeLiveOutput?.nodePath === event.node.node_path) {
        state.activeLiveOutput = null
      }
      return
    case "node_skipped":
      state.snapshot = event.snapshot
      return
    case "step_output":
      appendLiveStream(state, event.node_path, event.chunk)
      return
    case "provider_event":
      appendProviderEvent(state, event.node_path, event.event)
      return
    case "barrier_reached":
      state.snapshot = event.snapshot
      if (event.barrier.completed !== null && event.barrier.completed !== undefined) {
        state.lastCompletedNodePath = event.barrier.completed.node_path
      }
      return
    case "barrier_resolved":
      state.snapshot = event.snapshot
      return
    case "interaction_requested":
      state.snapshot = event.snapshot
      return
    case "interaction_resolved":
      state.snapshot = event.snapshot
      return
    case "run_finished":
      state.snapshot = event.snapshot
      state.activeLiveOutput = null
      return
  }
}

export function renderTerminalFrame(state: TerminalUiState, options: RenderOptions = {}): string {
  const lines = ["=== Rigg Run ===", ...renderHeader(state.snapshot)]
  const body = renderBody(state, options)

  if (body.length > 0) {
    lines.push("")
    lines.push(...body)
  }

  return `${lines.join("\n")}\n`
}

async function promptBarrier(
  readline: ReturnType<typeof createInterface>,
): Promise<Extract<RunControlResolution, { kind: "step_barrier" }>> {
  while (true) {
    const raw = (await readline.question("> ")).trim().toLowerCase()
    if (raw === "c" || raw === "continue") {
      return { action: "continue", kind: "step_barrier" }
    }
    if (raw === "a" || raw === "abort") {
      return { action: "abort", kind: "step_barrier" }
    }
  }
}

async function handleInteraction(
  readline: ReturnType<typeof createInterface>,
  render: (options?: RenderOptions) => void,
  interaction: PendingInteraction,
): Promise<Exclude<RunControlResolution, { kind: "step_barrier" }>> {
  const request = interaction.request as CodexInteractionRequest

  switch (request.kind) {
    case "approval":
      return await promptApproval(readline, request)
    case "user_input":
      return await promptUserInput(readline, render, interaction)
    case "elicitation":
      return await promptElicitation(readline, request)
  }
}

async function promptApproval(
  readline: ReturnType<typeof createInterface>,
  request: Extract<CodexInteractionRequest, { kind: "approval" }>,
): Promise<Extract<RunControlResolution, { kind: "approval" }>> {
  while (true) {
    const raw = (await readline.question("> ")).trim().toLowerCase()

    if (raw === "y" || raw === "approve") {
      return { decision: "accept", kind: "approval" }
    }
    if (raw === "n" || raw === "deny") {
      return { decision: "decline", kind: "approval" }
    }
    if (raw === "c" || raw === "cancel") {
      return { decision: "cancel", kind: "approval" }
    }

    if (request.availableDecisions.length > 0) {
      process.stderr.write(`Available provider decisions: ${request.availableDecisions.join(", ")}\n`)
    }
  }
}

async function promptUserInput(
  readline: ReturnType<typeof createInterface>,
  render: (options?: RenderOptions) => void,
  interaction: PendingInteraction,
): Promise<Extract<RunControlResolution, { kind: "user_input" }>> {
  const request = interaction.request as Extract<CodexInteractionRequest, { kind: "user_input" }>
  const answers: Record<string, { answers: string[] }> = {}

  for (const [index, question] of request.questions.entries()) {
    render({ userInputQuestionIndex: index })
    const answer = await promptLine(readline, "> ")
    answers[question.id] = {
      answers: [normalizeQuestionAnswer(answer, question.options)],
    }
  }

  return { answers, kind: "user_input" }
}

async function promptElicitation(
  readline: ReturnType<typeof createInterface>,
  request: Extract<CodexInteractionRequest, { kind: "elicitation" }>,
): Promise<Extract<RunControlResolution, { kind: "elicitation" }>> {
  const action = await promptChoice(readline, "> ", {
    a: "accept",
    accept: "accept",
    c: "cancel",
    cancel: "cancel",
    d: "decline",
    deny: "decline",
  })

  if (action !== "accept" || request.mode === "url") {
    return { action, kind: "elicitation" }
  }

  return {
    action,
    content: await promptJson(readline, "JSON response: "),
    kind: "elicitation",
  }
}

function renderHeader(snapshot: RunSnapshot | null): string[] {
  if (snapshot === null) {
    return ["Workflow : waiting", "Run ID   : waiting", "Status   : waiting"]
  }

  return [`Workflow : ${snapshot.workflow_id}`, `Run ID   : ${snapshot.run_id}`, `Status   : ${renderStatus(snapshot)}`]
}

function renderBody(state: TerminalUiState, options: RenderOptions): string[] {
  const snapshot = state.snapshot
  if (snapshot === null) {
    return []
  }

  if (snapshot.active_interaction != null) {
    return renderInteractionBody(state, snapshot.active_interaction, options)
  }

  if (snapshot.active_barrier != null) {
    return renderBarrierBody(state, snapshot.active_barrier)
  }

  if (snapshot.status !== "running") {
    return renderFinishedBody(state)
  }

  if (snapshot.active_node_path != null) {
    return renderRunningBody(state, snapshot.active_node_path)
  }

  return []
}

function renderRunningBody(state: TerminalUiState, nodePath: string): string[] {
  const node = state.snapshot === null ? null : findNode(state.snapshot, nodePath)
  const label = node === null ? nodePath : formatStepLabel(node)
  const kind = node?.node_kind ?? "unknown"
  const lines = [`Running: ${label} [${kind}]`]

  if (state.activeLiveOutput?.nodePath !== nodePath) {
    return lines
  }

  for (const entry of state.activeLiveOutput.entries) {
    const renderedLines = splitLines(entry.text)
    if (renderedLines.length === 0) {
      lines.push(entry.variant === "event" ? "  > [codex]" : "  >")
      continue
    }
    for (const line of renderedLines) {
      lines.push(renderLiveLine(entry.variant, line))
    }
  }

  return lines
}

function renderBarrierBody(state: TerminalUiState, barrier: StepBarrier): string[] {
  const lines: string[] = []
  appendSection(lines, renderLastCompletedSection(state))

  if (barrier.next.length <= 1) {
    const next = barrier.next[0]
    lines.push(next === undefined ? "Next: (none)" : `Next: ${formatFrontierLabel(next)}`)
  } else {
    lines.push("Next:")
    for (const next of barrier.next) {
      lines.push(`  ${formatFrontierLabel(next)}`)
    }
  }

  lines.push("")
  lines.push("[c]ontinue  [a]bort")
  return lines
}

function renderInteractionBody(
  state: TerminalUiState,
  interaction: PendingInteraction,
  options: RenderOptions,
): string[] {
  const request = interaction.request as CodexInteractionRequest
  const lines: string[] = []
  appendSection(lines, renderLastCompletedSection(state))

  switch (request.kind) {
    case "approval":
      lines.push(`Approve: ${request.command ?? request.requestKind}`)
      lines.push(`  reason: ${request.message}`)
      if (request.cwd) {
        lines.push(`  cwd: ${request.cwd}`)
      }
      lines.push("")
      lines.push("[y]approve  [n]deny  [c]cancel")
      return lines
    case "user_input": {
      const questionIndex = Math.min(options.userInputQuestionIndex ?? 0, Math.max(request.questions.length - 1, 0))
      const question = request.questions[questionIndex]
      if (question === undefined) {
        return lines
      }

      lines.push(formatUserInputHeader(question.header, questionIndex, request.questions.length))
      lines.push(question.question)
      if (question.options !== null && question.options.length > 0) {
        lines.push("")
        for (const [index, option] of question.options.entries()) {
          lines.push(`  ${index + 1}. ${option.label}`)
        }
      }
      lines.push("")
      lines.push("Answer:")
      return lines
    }
    case "elicitation":
      lines.push(`Request: ${request.message}`)
      if (request.mode === "url") {
        lines.push(`  url: ${request.url}`)
      } else {
        lines.push(`  schema: ${compactJson(request.requestedSchema)}`)
      }
      lines.push("")
      lines.push("[a]ccept  [d]eny  [c]cancel")
      return lines
  }
}

function renderFinishedBody(state: TerminalUiState): string[] {
  const lines: string[] = []
  appendSection(lines, renderLastCompletedSection(state))
  lines.push("Run finished.")
  return lines
}

function renderLastCompletedSection(state: TerminalUiState): string[] {
  if (state.snapshot === null || state.lastCompletedNodePath === null) {
    return []
  }

  const node = findNode(state.snapshot, state.lastCompletedNodePath)
  if (node === null) {
    return []
  }

  return renderCompletedStep(node)
}

function renderCompletedStep(node: NodeSnapshot): string[] {
  const lines = [formatCompletedHeader(node)]
  if (node.status === "succeeded") {
    lines.push(...renderSucceededOutput(node))
    return lines
  }

  lines.push(...renderFailedOutput(node))
  return lines
}

function renderSucceededOutput(node: NodeSnapshot): string[] {
  const stdoutLines = toOutputLines(node.stdout)
  const stderrLines = toOutputLines(node.stderr)
  const lines: string[] = []

  if (stdoutLines.length === 0) {
    lines.push("  (no output)")
  } else if (stdoutLines.length <= 5) {
    lines.push(...indentLines(stdoutLines, "  "))
  } else {
    lines.push(...indentLines(stdoutLines.slice(0, 5), "  "))
    lines.push(`  … +${stdoutLines.length - 5} lines`)
  }

  if (stderrLines.length > 0) {
    lines.push("  stderr:")
    lines.push(...indentLines(stderrLines, "    "))
  }

  return lines
}

function renderFailedOutput(node: NodeSnapshot): string[] {
  const stdoutLines = toOutputLines(node.stdout)
  const stderrLines = toOutputLines(node.stderr)

  return [
    "  stdout:",
    ...indentLines(stdoutLines.length === 0 ? ["(no output)"] : stdoutLines, "    "),
    "  stderr:",
    ...indentLines(stderrLines.length === 0 ? ["(no output)"] : stderrLines, "    "),
  ]
}

function renderStatus(snapshot: RunSnapshot): string {
  if (snapshot.active_interaction?.kind === "approval") {
    return "waiting (approval)"
  }
  if (snapshot.active_interaction !== null || snapshot.active_barrier !== null) {
    return "waiting"
  }
  return snapshot.status
}

function appendSection(lines: string[], section: string[]): void {
  if (section.length === 0) {
    return
  }
  if (lines.length > 0) {
    lines.push("")
  }
  lines.push(...section)
}

function findNode(snapshot: RunSnapshot, nodePath: string): NodeSnapshot | null {
  return snapshot.nodes.find((node) => node.node_path === nodePath) ?? null
}

function formatStepLabel(node: Pick<NodeSnapshot, "node_path" | "user_id">): string {
  return node.user_id ?? node.node_path
}

function formatFrontierLabel(node: FrontierNode): string {
  const suffix = node.cwd ? ` cwd=${node.cwd}` : ""
  return `${node.user_id ?? node.node_path} [${node.node_kind}]${suffix}`
}

function formatCompletedHeader(node: NodeSnapshot): string {
  const details: string[] = [node.status]
  if (node.exit_code !== null && node.exit_code !== undefined) {
    details.push(`exit ${node.exit_code}`)
  }
  if (node.duration_ms !== null && node.duration_ms !== undefined) {
    details.push(`${(node.duration_ms / 1000).toFixed(1)}s`)
  }
  return `--- ${formatStepLabel(node)} (${details.join(", ")}) ---`
}

function formatUserInputHeader(header: string, index: number, total: number): string {
  if (total <= 1) {
    return `Question: ${header}`
  }
  return `Question ${index + 1}/${total}: ${header}`
}

function appendLiveStream(state: TerminalUiState, nodePath: string, chunk: string): void {
  const liveOutput = ensureActiveLiveOutput(state, nodePath)
  const lastEntry = liveOutput.entries.at(-1)
  if (lastEntry !== undefined && lastEntry.variant === "stream") {
    lastEntry.text += chunk
    return
  }

  liveOutput.entries.push({
    key: null,
    text: chunk,
    variant: "stream",
  })
}

function appendProviderEvent(state: TerminalUiState, nodePath: string, event: CodexProviderEvent): void {
  const liveOutput = ensureActiveLiveOutput(state, nodePath)

  switch (event.kind) {
    case "message_delta":
      upsertAssistantEntry(liveOutput, event.itemId ?? event.turnId, (current) => current + event.text)
      return
    case "message_completed":
      upsertAssistantEntry(liveOutput, event.itemId ?? event.turnId, () => event.text)
      return
    case "tool_started":
      liveOutput.entries.push({
        key: null,
        text: `tool started: ${event.tool}${event.detail ? ` (${event.detail})` : ""}`,
        variant: "event",
      })
      return
    case "tool_completed":
      liveOutput.entries.push({
        key: null,
        text: `tool completed: ${event.tool}${event.detail ? ` (${event.detail})` : ""}`,
        variant: "event",
      })
      return
    case "diagnostic":
      liveOutput.entries.push({
        key: null,
        text: `diagnostic: ${event.message}`,
        variant: "event",
      })
      return
    case "error":
      liveOutput.entries.push({
        key: null,
        text: `error: ${event.message}`,
        variant: "event",
      })
      return
    case "thread_started":
    case "turn_started":
    case "turn_completed":
      return
  }
}

function ensureActiveLiveOutput(state: TerminalUiState, nodePath: string): ActiveLiveOutput {
  if (state.activeLiveOutput?.nodePath === nodePath) {
    return state.activeLiveOutput
  }

  state.activeLiveOutput = {
    entries: [],
    nodePath,
  }
  return state.activeLiveOutput
}

function upsertAssistantEntry(liveOutput: ActiveLiveOutput, key: string, update: (current: string) => string): void {
  const entry = [...liveOutput.entries]
    .reverse()
    .find((candidate) => candidate.variant === "assistant" && candidate.key === key)
  if (entry !== undefined) {
    entry.text = update(entry.text)
    return
  }

  liveOutput.entries.push({
    key,
    text: update(""),
    variant: "assistant",
  })
}

function renderLiveLine(variant: LiveLogEntry["variant"], line: string): string {
  if (variant === "event") {
    return line.length === 0 ? "  > [codex]" : `  > [codex] ${line}`
  }
  return line.length === 0 ? "  >" : `  > ${line}`
}

function normalizeQuestionAnswer(
  answer: string,
  options: ReadonlyArray<{ description: string; label: string }> | null,
): string {
  if (options === null) {
    return answer
  }

  const index = Number.parseInt(answer, 10)
  if (Number.isInteger(index) && index >= 1 && index <= options.length) {
    return options[index - 1]?.label ?? answer
  }

  return answer
}

function toOutputLines(value: unknown): string[] {
  return splitLines(stringifyUnknown(value))
}

function splitLines(value: string): string[] {
  if (value.length === 0) {
    return []
  }

  const lines = value.replaceAll(/\r\n?/g, "\n").split("\n")
  while (lines.at(-1) === "") {
    lines.pop()
  }
  return lines
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value
  }
  if (value === null || value === undefined) {
    return ""
  }
  return JSON.stringify(value, null, 2) ?? ""
}

function compactJson(value: unknown): string {
  if (value === null || value === undefined) {
    return "{}"
  }
  return JSON.stringify(value) ?? "{}"
}

function indentLines(lines: string[], prefix: string): string[] {
  return lines.map((line) => `${prefix}${line}`)
}

async function promptChoice<TChoice extends string>(
  readline: ReturnType<typeof createInterface>,
  prompt: string,
  map: Record<string, TChoice>,
): Promise<TChoice> {
  while (true) {
    const raw = (await readline.question(prompt)).trim().toLowerCase()
    const choice = map[raw]
    if (choice !== undefined) {
      return choice
    }
  }
}

async function promptLine(readline: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  while (true) {
    const value = (await readline.question(prompt)).trim()
    if (value.length > 0) {
      return value
    }
  }
}

async function promptJson(readline: ReturnType<typeof createInterface>, prompt: string): Promise<unknown> {
  while (true) {
    const value = await promptLine(readline, prompt)
    try {
      return JSON.parse(value)
    } catch {}
  }
}
