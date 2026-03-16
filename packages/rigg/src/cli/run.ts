import { createInterface } from "node:readline/promises"

import type { CodexApprovalDecision } from "../codex/interaction"
import type { CodexProviderEvent } from "../codex/event"
import type { CodexInteractionRequest } from "../codex/interaction"
import type { RunControlHandler, RunControlResolution, RunEvent } from "../run/progress"
import type { FrontierNode, NodeSnapshot, PendingInteraction, RunSnapshot, StepBarrier } from "../run/schema"
import { stringifyJsonCompact, tryParseJson } from "../util/json"

const CLEAR_SCREEN = "\u001b[2J\u001b[H"

type ActiveLiveOutput = {
  entries: LiveLogEntry[]
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
  lastCompletedNodePath: string | null
  liveOutputs: Record<string, ActiveLiveOutput>
  snapshot: RunSnapshot | null
}

export type RunSession = {
  close: () => void
  emit: (event: RunEvent) => void
  handle: RunControlHandler
}

export function createTerminalUiState(): TerminalUiState {
  return {
    lastCompletedNodePath: null,
    liveOutputs: {},
    snapshot: null,
  }
}

export function createTerminalRunSession(input: NodeJS.ReadStream, output: NodeJS.WriteStream): RunSession {
  const readline = createInterface({
    input,
    output,
    terminal: Boolean(output.isTTY),
  })
  const state = createTerminalUiState()
  const render = createTerminalRenderer(state, output)
  const handle = createInteractiveRunHandler(readline, state, render)

  function emit(event: RunEvent): void {
    applyRunEvent(state, event)
    render()
  }

  return {
    close: () => readline.close(),
    emit,
    handle,
  }
}

function createTerminalRenderer(state: TerminalUiState, output: NodeJS.WriteStream): (options?: RenderOptions) => void {
  return (options: RenderOptions = {}) => {
    const frame = renderTerminalFrame(state, options)
    if (output.isTTY) {
      output.write(CLEAR_SCREEN)
    }
    output.write(frame)
  }
}

function createInteractiveRunHandler(
  readline: ReturnType<typeof createInterface>,
  state: TerminalUiState,
  render: (options?: RenderOptions) => void,
): RunControlHandler {
  return async (request) => {
    state.snapshot = request.snapshot

    if (request.kind === "step_barrier") {
      render()
      return await promptBarrier(readline, request.signal)
    }

    if (request.interaction.kind === "user_input") {
      return await promptUserInput(
        readline,
        render,
        requireInteractionRequest(request.interaction, "user_input"),
        request.signal,
      )
    }

    render()
    return await handleInteraction(readline, render, request.interaction, request.signal)
  }
}

export function createNonInteractiveRunSession(): RunSession {
  return {
    close: () => {},
    emit: () => {},
    handle: async (request) => {
      if (request.kind === "step_barrier") {
        return { action: "continue", kind: "step_barrier" }
      }

      throw new Error(
        `workflow requires operator interaction (${request.interaction.kind}), but rigg run is not attached to an interactive terminal`,
      )
    },
  }
}

export function applyRunEvent(state: TerminalUiState, event: RunEvent): void {
  switch (event.kind) {
    case "run_started":
      state.liveOutputs = {}
      state.lastCompletedNodePath = null
      state.snapshot = event.snapshot
      return
    case "node_started":
      state.snapshot = event.snapshot
      state.liveOutputs[event.node.node_path] = {
        entries: [],
      }
      return
    case "node_completed":
      state.snapshot = event.snapshot
      state.lastCompletedNodePath = event.node.node_path
      delete state.liveOutputs[event.node.node_path]
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
      state.liveOutputs = {}
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
  signal: AbortSignal,
): Promise<Extract<RunControlResolution, { kind: "step_barrier" }>> {
  while (true) {
    const raw = (await readline.question("> ", { signal })).trim().toLowerCase()
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
  signal: AbortSignal,
): Promise<Exclude<RunControlResolution, { kind: "step_barrier" }>> {
  const request = requireInteractionRequest(interaction)

  switch (request.kind) {
    case "approval":
      return await promptApproval(readline, request, signal)
    case "user_input":
      return await promptUserInput(readline, render, request, signal)
    case "elicitation":
      return await promptElicitation(readline, request, signal)
  }
}

async function promptApproval(
  readline: ReturnType<typeof createInterface>,
  request: Extract<CodexInteractionRequest, { kind: "approval" }>,
  signal: AbortSignal,
): Promise<Extract<RunControlResolution, { kind: "approval" }>> {
  const choices = buildApprovalPromptChoices(request.decisions)

  while (true) {
    const raw = (await readline.question("> ", { signal })).trim().toLowerCase()
    const choice = choices[raw]
    if (choice !== undefined) {
      return { decision: choice, kind: "approval" }
    }

    if (request.decisions.length > 0) {
      process.stderr.write(
        `Available provider decisions: ${request.decisions.map((decision) => decision.value).join(", ")}\n`,
      )
    }
  }
}

async function promptUserInput(
  readline: ReturnType<typeof createInterface>,
  render: (options?: RenderOptions) => void,
  request: Extract<CodexInteractionRequest, { kind: "user_input" }>,
  signal: AbortSignal,
): Promise<Extract<RunControlResolution, { kind: "user_input" }>> {
  const answers: Record<string, { answers: string[] }> = {}

  for (const [index, question] of request.questions.entries()) {
    render({ userInputQuestionIndex: index })
    const answer = await promptLine(readline, "> ", signal)
    answers[question.id] = {
      answers: [normalizeQuestionAnswer(answer, question.options)],
    }
  }

  return { answers, kind: "user_input" }
}

async function promptElicitation(
  readline: ReturnType<typeof createInterface>,
  request: Extract<CodexInteractionRequest, { kind: "elicitation" }>,
  signal: AbortSignal,
): Promise<Extract<RunControlResolution, { kind: "elicitation" }>> {
  const action = await promptChoice(readline, "> ", signal, {
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
    content: await promptJson(readline, "JSON response: ", signal),
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

  const activeNodes = snapshot.nodes.filter((node) => node.status === "running")
  if (activeNodes.length > 0) {
    return renderRunningBody(state, activeNodes)
  }

  return []
}

function renderRunningBody(state: TerminalUiState, nodes: NodeSnapshot[]): string[] {
  const lines: string[] = []

  for (const node of nodes) {
    appendSection(lines, renderRunningNode(state, node))
  }

  return lines
}

function renderRunningNode(state: TerminalUiState, node: NodeSnapshot): string[] {
  const lines = [`Running: ${node.user_id ?? node.node_path} [${node.node_kind}]`]
  const liveOutput = state.liveOutputs[node.node_path]

  if (liveOutput === undefined) {
    return lines
  }

  for (const entry of liveOutput.entries) {
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
  const request = requireInteractionRequest(interaction)
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
      lines.push(renderApprovalPrompt(request.decisions))
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
        lines.push(`  schema: ${stringifyJsonCompact(request.requestedSchema ?? {})}`)
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

  const node = state.snapshot.nodes.find((n) => n.node_path === state.lastCompletedNodePath) ?? null
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
  const stdoutLines = splitLines(stringifyUnknown(node.stdout))
  const stderrLines = splitLines(stringifyUnknown(node.stderr))
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
  const stdoutLines = splitLines(stringifyUnknown(node.stdout))
  const stderrLines = splitLines(stringifyUnknown(node.stderr))

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
  return `--- ${node.user_id ?? node.node_path} (${details.join(", ")}) ---`
}

function formatUserInputHeader(header: string, index: number, total: number): string {
  if (total <= 1) {
    return `Question: ${header}`
  }
  return `Question ${index + 1}/${total}: ${header}`
}

function appendLiveStream(state: TerminalUiState, nodePath: string, chunk: string): void {
  const liveOutput = ensureLiveOutput(state, nodePath)
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
  const liveOutput = ensureLiveOutput(state, nodePath)

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

function ensureLiveOutput(state: TerminalUiState, nodePath: string): ActiveLiveOutput {
  const existing = state.liveOutputs[nodePath]
  if (existing !== undefined) {
    return existing
  }

  const liveOutput = { entries: [] }
  state.liveOutputs[nodePath] = liveOutput
  return liveOutput
}

function upsertAssistantEntry(liveOutput: ActiveLiveOutput, key: string, update: (current: string) => string): void {
  for (let i = liveOutput.entries.length - 1; i >= 0; i--) {
    const candidate = liveOutput.entries[i]
    if (candidate === undefined) {
      continue
    }
    if (candidate.variant === "assistant" && candidate.key === key) {
      candidate.text = update(candidate.text)
      return
    }
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

function renderApprovalPrompt(decisions: ReadonlyArray<CodexApprovalDecision>): string {
  if (decisions.length === 0) {
    return "Enter a provider decision."
  }

  return decisions
    .map((decision, index) => {
      const shortcut = approvalShortcut(decision, index)
      return `[${shortcut}]${decision.value}`
    })
    .join("  ")
}

function buildApprovalPromptChoices(decisions: ReadonlyArray<CodexApprovalDecision>): Record<string, string> {
  const choices: Record<string, string> = {}

  for (const [index, decision] of decisions.entries()) {
    const normalizedValue = decision.value.trim().toLowerCase()
    if (normalizedValue.length > 0) {
      choices[normalizedValue] = decision.value
    }

    choices[String(index + 1)] = decision.value

    const shortcut = approvalShortcut(decision, index)
    choices[shortcut] = decision.value
  }

  return choices
}

function approvalShortcut(decision: CodexApprovalDecision, index: number): string {
  switch (decision.intent) {
    case "approve":
      return "y"
    case "deny":
      return "n"
    case "cancel":
      return "c"
    case null:
      return String(index + 1)
  }
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

function requireInteractionRequest(interaction: PendingInteraction): CodexInteractionRequest
function requireInteractionRequest<TKind extends CodexInteractionRequest["kind"]>(
  interaction: PendingInteraction,
  kind: TKind,
): Extract<CodexInteractionRequest, { kind: TKind }>
function requireInteractionRequest<TKind extends CodexInteractionRequest["kind"]>(
  interaction: PendingInteraction,
  kind?: TKind,
): CodexInteractionRequest {
  const requestKind = kind ?? interaction.kind
  if (isInteractionRequest(interaction.request, requestKind)) {
    return interaction.request
  }

  throw new Error(`run snapshot contained an invalid ${requestKind} interaction request`)
}

function isInteractionRequest<TKind extends CodexInteractionRequest["kind"]>(
  value: unknown,
  kind: TKind,
): value is Extract<CodexInteractionRequest, { kind: TKind }> {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === kind
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

function indentLines(lines: string[], prefix: string): string[] {
  return lines.map((line) => `${prefix}${line}`)
}

async function promptChoice<TChoice extends string>(
  readline: ReturnType<typeof createInterface>,
  prompt: string,
  signal: AbortSignal,
  map: Record<string, TChoice>,
): Promise<TChoice> {
  while (true) {
    const raw = (await readline.question(prompt, { signal })).trim().toLowerCase()
    const choice = map[raw]
    if (choice !== undefined) {
      return choice
    }
  }
}

async function promptLine(
  readline: ReturnType<typeof createInterface>,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  while (true) {
    const value = (await readline.question(prompt, { signal })).trim()
    if (value.length > 0) {
      return value
    }
  }
}

async function promptJson(
  readline: ReturnType<typeof createInterface>,
  prompt: string,
  signal: AbortSignal,
): Promise<unknown> {
  while (true) {
    const value = await promptLine(readline, prompt, signal)
    const parsed = tryParseJson(value)
    if (parsed !== undefined) {
      return parsed
    }
  }
}
