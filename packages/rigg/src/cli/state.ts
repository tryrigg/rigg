import type { RunEvent, StreamKind, ProviderEvent } from "../session/event"
import type { FrontierNode, RunSnapshot } from "../session/schema"

export type ApprovalMode = "manual" | "auto_continue"

export type LiveLogEntry = {
  key: string | null
  stream?: StreamKind
  text: string
  variant: "assistant" | "event" | "stream"
}

export type LiveOutput = {
  entries: LiveLogEntry[]
}

export type OutputPreview = {
  stream: "stderr" | "stdout"
  text: string
}

export type CompletedOutput = {
  entries: LiveLogEntry[]
  preview: OutputPreview | null
}

export type UiState = {
  barrierMode: ApprovalMode
  completedOutputs: Record<string, CompletedOutput>
  lastCompletedNodePath: string | null
  liveOutputs: Record<string, LiveOutput>
  snapshot: RunSnapshot | null
}

const labels: Record<string, string> = {
  codex: "codex",
  cursor: "cursor",
  shell: "cmd",
  write_file: "write_file",
}

export function createState(barrierMode: ApprovalMode = "manual"): UiState {
  return {
    barrierMode,
    completedOutputs: {},
    lastCompletedNodePath: null,
    liveOutputs: {},
    snapshot: null,
  }
}

export function previewOutput(node: { status: string; stderr?: unknown; stdout?: unknown }): OutputPreview | null {
  const order =
    node.status === "failed" || node.status === "interrupted"
      ? (["stderr", "stdout"] as const)
      : (["stdout", "stderr"] as const)

  for (const stream of order) {
    const raw = node[stream]
    if (typeof raw !== "string") {
      continue
    }

    const text = truncate(raw)
    if (text !== null) {
      return { stream, text }
    }
  }

  return null
}

export function applyEvent(state: UiState, event: RunEvent): void {
  switch (event.kind) {
    case "run_started":
      state.liveOutputs = {}
      state.completedOutputs = {}
      state.lastCompletedNodePath = null
      state.snapshot = event.snapshot
      return
    case "node_started":
      state.snapshot = event.snapshot
      return
    case "node_completed": {
      state.snapshot = event.snapshot
      state.lastCompletedNodePath = event.node.node_path
      const live = state.liveOutputs[event.node.node_path]
      state.completedOutputs[event.node.node_path] = {
        entries: live?.entries ?? [],
        preview: previewOutput(event.node),
      }
      delete state.liveOutputs[event.node.node_path]
      return
    }
    case "node_skipped":
    case "barrier_resolved":
    case "interaction_requested":
    case "interaction_resolved":
      state.snapshot = event.snapshot
      return
    case "step_output":
      appendLiveStream(state, event.node_path, event.chunk, event.stream)
      return
    case "provider_event":
      appendProviderEvent(state, event.node_path, event.event)
      return
    case "barrier_reached":
      state.snapshot = event.snapshot
      if (event.barrier.completed !== null && event.barrier.completed !== undefined) {
        state.lastCompletedNodePath = event.barrier.completed.node_path
        appendAutoContinue(state, event)
      }
      return
    case "run_finished":
      state.snapshot = event.snapshot
      for (const [nodePath, live] of Object.entries(state.liveOutputs)) {
        const node = event.snapshot.nodes.find((item) => item.node_path === nodePath)
        state.completedOutputs[nodePath] = {
          entries: live.entries,
          preview: node ? previewOutput(node) : null,
        }
      }
      state.liveOutputs = {}
      return
  }
}

function truncate(raw: string): string | null {
  if (raw.length === 0) {
    return null
  }
  const lines = raw.replace(/\r\n?/g, "\n").split("\n").filter(Boolean)
  if (lines.length <= 3) {
    return lines.join("\n")
  }
  return [`... +${lines.length - 3} earlier lines`, ...lines.slice(-3)].join("\n")
}

function appendAutoContinue(state: UiState, event: Extract<RunEvent, { kind: "barrier_reached" }>): void {
  if (state.barrierMode !== "auto_continue") {
    return
  }

  const completed = event.barrier.completed
  if (completed === null || completed === undefined) {
    return
  }

  const label = barrierLabel(event.barrier.next)
  if (label === null) {
    return
  }

  const output = ensureCompletedOutput(state, completed.node_path)
  output.entries.push({
    key: null,
    text: `auto-continue: Next: ${label}`,
    variant: "event",
  })
}

function ensureCompletedOutput(state: UiState, nodePath: string): CompletedOutput {
  const current = state.completedOutputs[nodePath]
  if (current !== undefined) {
    return current
  }

  const node = state.snapshot?.nodes.find((item) => item.node_path === nodePath)
  const output = {
    entries: [],
    preview: node ? previewOutput(node) : null,
  }
  state.completedOutputs[nodePath] = output
  return output
}

function barrierLabel(next: FrontierNode[]): string | null {
  if (next.length === 0) {
    return null
  }

  return next.map((node) => frontierLabel(node)).join(", ")
}

export function frontierLabel(node: FrontierNode): string {
  const parts = [`${node.user_id ?? node.node_path} [${labels[node.node_kind] ?? node.node_kind}]`]
  if (node.node_kind === "codex" && node.codex_kind) {
    parts.push(node.codex_kind)
    if (node.codex_kind === "turn" && node.codex_collaboration_mode === "plan") {
      parts.push("plan")
    }
  }
  if (node.node_kind === "cursor" && node.cursor_mode) {
    parts.push(node.cursor_mode)
  }
  if ((node.node_kind === "codex" || node.node_kind === "cursor") && node.model) {
    parts.push(node.model)
  }
  return parts.join(" · ")
}

function appendLiveStream(state: UiState, nodePath: string, chunk: string, stream: StreamKind): void {
  const output = ensureLiveOutput(state, nodePath)
  const last = output.entries.at(-1)
  if (last !== undefined && last.variant === "stream" && last.stream === stream) {
    last.text += chunk
    return
  }

  output.entries.push({
    key: null,
    stream,
    text: chunk,
    variant: "stream",
  })
}

function appendProviderEvent(state: UiState, nodePath: string, event: ProviderEvent): void {
  const output = ensureLiveOutput(state, nodePath)

  switch (event.kind) {
    case "message_delta":
      upsertAssistant(
        output,
        event.provider === "codex" ? (event.itemId ?? event.turnId) : (event.messageId ?? event.sessionId),
        (current) => current + event.text,
      )
      return
    case "message_completed":
      upsertAssistant(output, event.itemId ?? event.turnId, () => event.text)
      return
    case "tool_started":
      output.entries.push({
        key: null,
        text: `tool started: ${event.tool}${event.detail ? ` (${event.detail})` : ""}`,
        variant: "event",
      })
      return
    case "tool_completed":
      output.entries.push({
        key: null,
        text: `tool completed: ${event.tool}${event.detail ? ` (${event.detail})` : ""}`,
        variant: "event",
      })
      return
    case "diagnostic":
      output.entries.push({
        key: null,
        text: `diagnostic: ${event.message}`,
        variant: "event",
      })
      return
    case "error":
      output.entries.push({
        key: null,
        text: `error: ${event.message}`,
        variant: "event",
      })
      return
    case "session_started":
    case "session_completed":
    case "thread_started":
    case "turn_started":
    case "turn_completed":
      return
  }
}

function ensureLiveOutput(state: UiState, nodePath: string): LiveOutput {
  const current = state.liveOutputs[nodePath]
  if (current !== undefined) {
    return current
  }

  const output = { entries: [] }
  state.liveOutputs[nodePath] = output
  return output
}

function upsertAssistant(output: LiveOutput, key: string, update: (current: string) => string): void {
  for (let i = output.entries.length - 1; i >= 0; i -= 1) {
    const item = output.entries[i]
    if (item === undefined) {
      continue
    }
    if (item.variant === "assistant" && item.key === key) {
      item.text = update(item.text)
      return
    }
  }

  output.entries.push({
    key,
    text: update(""),
    variant: "assistant",
  })
}
