import React from "react"
import { render } from "ink"

import type { CodexInteractionResolution } from "../codex/interaction"
import type { CodexProviderEvent } from "../codex/event"
import type { WorkflowDocument } from "../compile/schema"
import type { RunControlHandler, RunControlRequest, RunControlResolution, RunEvent, StreamKind } from "../run/progress"
import type { FrontierNode, RunSnapshot } from "../run/schema"
import { clonePendingInteraction, cloneRunSnapshot } from "../run/snapshot"
import { setActiveInteraction } from "../run/state"
import { onAbort } from "../util/abort"
import { createAbortError } from "../util/error"
import { App } from "./tui/app"
import { createTuiStore } from "./tui/store"

export type BarrierApprovalMode = "manual" | "auto_continue"

export type ActiveLiveOutput = {
  entries: LiveLogEntry[]
}

export type LiveLogEntry = {
  key: string | null
  stream?: StreamKind
  text: string
  variant: "assistant" | "event" | "stream"
}

export type CompletedOutput = {
  entries: LiveLogEntry[]
  preview: OutputPreview | null
}

export type OutputPreview = {
  stream: "stderr" | "stdout"
  text: string
}

export type TerminalUiState = {
  barrierMode: BarrierApprovalMode
  lastCompletedNodePath: string | null
  liveOutputs: Record<string, ActiveLiveOutput>
  completedOutputs: Record<string, CompletedOutput>
  snapshot: RunSnapshot | null
}

export type RunSession = {
  close: () => void
  emit: (event: RunEvent) => void
  handle: RunControlHandler
}

export type WorkflowInterruptHandler = () => void

type InteractiveTerminal = {
  stderr: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
}

type ResolverEntry =
  | {
      dispose: () => void
      kind: "interaction"
      reject: (error: unknown) => void
      resolve: (resolution: CodexInteractionResolution) => void
    }
  | {
      dispose: () => void
      kind: "step_barrier"
      reject: (error: unknown) => void
      resolve: (resolution: Extract<RunControlResolution, { kind: "step_barrier" }>) => void
    }

type ControlResolverRegistry = {
  clear: (reason?: unknown) => void
  register: (request: RunControlRequest) => Promise<RunControlResolution>
  resolveBarrier: (barrierId: string, action: "abort" | "continue") => void
  resolveInteraction: (interactionId: string, resolution: CodexInteractionResolution) => void
}

type InkRenderFunction = typeof render

export function createTerminalUiState(barrierMode: BarrierApprovalMode = "manual"): TerminalUiState {
  return {
    barrierMode,
    lastCompletedNodePath: null,
    liveOutputs: {},
    completedOutputs: {},
    snapshot: null,
  }
}

function truncateOutputText(raw: string): string | null {
  if (raw.length === 0) {
    return null
  }
  const lines = raw.replace(/\r\n?/g, "\n").split("\n").filter(Boolean)
  if (lines.length <= 3) {
    return lines.join("\n")
  }
  return [`... +${lines.length - 3} earlier lines`, ...lines.slice(-3)].join("\n")
}

export function previewNodeOutput(node: { status: string; stderr?: unknown; stdout?: unknown }): OutputPreview | null {
  const failedFirstStreams: ReadonlyArray<OutputPreview["stream"]> = ["stderr", "stdout"]
  const succeededFirstStreams: ReadonlyArray<OutputPreview["stream"]> = ["stdout", "stderr"]
  const preferredStreams =
    node.status === "failed" || node.status === "interrupted" ? failedFirstStreams : succeededFirstStreams

  for (const stream of preferredStreams) {
    const raw = node[stream]
    if (typeof raw !== "string") {
      continue
    }

    const text = truncateOutputText(raw)
    if (text !== null) {
      return { stream, text }
    }
  }

  return null
}

function resolveImmediateControlRequest(request: RunControlRequest): RunControlResolution | null {
  if (request.kind === "step_barrier") {
    return null
  }

  const interaction = request.interaction.request
  if (interaction.kind === "user_input" && interaction.questions.length === 0) {
    return {
      answers: {},
      kind: "user_input",
    }
  }

  return null
}

function withSyntheticActiveInteraction(
  snapshot: RunSnapshot,
  request: RunControlRequest & { kind: "interaction" },
): RunSnapshot {
  const nextSnapshot = cloneRunSnapshot(snapshot)
  setActiveInteraction(nextSnapshot, clonePendingInteraction(request.interaction))
  return nextSnapshot
}

function withoutSyntheticActiveInteraction(snapshot: RunSnapshot, interactionId: string): RunSnapshot {
  const nextSnapshot = cloneRunSnapshot(snapshot)
  if (nextSnapshot.active_interaction?.interaction_id === interactionId) {
    setActiveInteraction(nextSnapshot, null)
  }
  return nextSnapshot
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

export function createInkRenderOptions(terminal: InteractiveTerminal): NonNullable<Parameters<InkRenderFunction>[1]> {
  return {
    exitOnCtrlC: false,
    stderr: terminal.stderr,
    stdin: terminal.stdin,
    stdout: terminal.stderr,
  }
}

export function createControlResolverRegistry(): ControlResolverRegistry {
  const entries = new Map<string, ResolverEntry>()

  function releaseEntry(id: string): ResolverEntry | undefined {
    const entry = entries.get(id)
    if (entry === undefined) {
      return undefined
    }
    entries.delete(id)
    entry.dispose()
    return entry
  }

  return {
    clear: (reason) => {
      const error = createAbortError(reason ?? "run session closed")
      for (const [id, entry] of entries) {
        entries.delete(id)
        entry.dispose()
        entry.reject(error)
      }
    },
    register: (request) => {
      const id = request.kind === "step_barrier" ? request.barrier.barrier_id : request.interaction.interaction_id

      return new Promise<RunControlResolution>((resolve, reject) => {
        let disposeAbort = () => {}
        const abortListener = () => {
          const entry = releaseEntry(id)
          entry?.reject(createAbortError(request.signal.reason))
        }

        const entry: ResolverEntry =
          request.kind === "step_barrier"
            ? {
                dispose: () => disposeAbort(),
                kind: "step_barrier",
                reject,
                resolve: (resolution) => resolve(resolution),
              }
            : {
                dispose: () => disposeAbort(),
                kind: "interaction",
                reject,
                resolve: (resolution) => resolve(resolution),
              }

        entries.set(id, entry)
        disposeAbort = onAbort(request.signal, abortListener)
      })
    },
    resolveBarrier: (barrierId, action) => {
      const entry = releaseEntry(barrierId)
      if (entry?.kind !== "step_barrier") {
        return
      }
      entry.resolve({ action, kind: "step_barrier" })
    },
    resolveInteraction: (interactionId, resolution) => {
      const entry = releaseEntry(interactionId)
      if (entry?.kind !== "interaction") {
        return
      }
      entry.resolve(resolution)
    },
  }
}

export function createInkRunSession(options: {
  barrierMode: BarrierApprovalMode
  interrupt: WorkflowInterruptHandler
  renderApp?: InkRenderFunction
  terminal?: InteractiveTerminal
  workflow: WorkflowDocument
}): RunSession {
  const store = createTuiStore({ barrierMode: options.barrierMode })
  const controlResolvers = createControlResolverRegistry()
  const terminal = options.terminal ?? {
    stderr: process.stderr,
    stdin: process.stdin,
  }
  const renderApp = options.renderApp ?? render
  const inkInstance = renderApp(
    React.createElement(App, {
      barrierMode: options.barrierMode,
      onInterrupt: options.interrupt,
      onResolveBarrier: (barrierId: string, action: "abort" | "continue") =>
        controlResolvers.resolveBarrier(barrierId, action),
      onResolveInteraction: (interactionId: string, resolution: CodexInteractionResolution) =>
        controlResolvers.resolveInteraction(interactionId, resolution),
      store,
      workflow: options.workflow,
    }),
    createInkRenderOptions(terminal),
  )

  return {
    close: () => {
      controlResolvers.clear("run session closed")
      store.stopTimer()
      inkInstance.unmount()
    },
    emit: (event) => {
      store.dispatch(event)
      if (event.kind === "run_started") {
        store.startTimer()
      }
      if (event.kind === "run_finished") {
        store.stopTimer()
      }
    },
    handle: (request) => {
      if (request.kind === "step_barrier" && options.barrierMode === "auto_continue") {
        return { action: "continue", kind: "step_barrier" }
      }

      const immediateResolution = resolveImmediateControlRequest(request)
      if (immediateResolution !== null) {
        return immediateResolution
      }

      if (request.kind !== "interaction" || store.getSnapshot().state.snapshot !== null) {
        return controlResolvers.register(request)
      }

      store.replaceSnapshot(withSyntheticActiveInteraction(request.snapshot, request))

      return Promise.resolve(controlResolvers.register(request)).then(
        (resolution) => {
          const currentSnapshot = store.getSnapshot().state.snapshot
          if (currentSnapshot !== null) {
            store.replaceSnapshot(
              withoutSyntheticActiveInteraction(currentSnapshot, request.interaction.interaction_id),
            )
          }
          return resolution
        },
        (error) => {
          const currentSnapshot = store.getSnapshot().state.snapshot
          if (currentSnapshot !== null) {
            store.replaceSnapshot(
              withoutSyntheticActiveInteraction(currentSnapshot, request.interaction.interaction_id),
            )
          }
          throw error
        },
      )
    },
  }
}

const FRONTIER_KIND_LABELS: Record<string, string> = {
  codex: "codex",
  shell: "cmd",
  write_file: "write_file",
}

export function applyRunEvent(state: TerminalUiState, event: RunEvent): void {
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
        preview: previewNodeOutput(event.node),
      }
      delete state.liveOutputs[event.node.node_path]
      return
    }
    case "node_skipped":
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
        appendAutoContinueEvent(state, event)
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
      for (const [nodePath, live] of Object.entries(state.liveOutputs)) {
        const node = event.snapshot.nodes.find((n) => n.node_path === nodePath)
        state.completedOutputs[nodePath] = {
          entries: live.entries,
          preview: node ? previewNodeOutput(node) : null,
        }
      }
      state.liveOutputs = {}
      return
  }
}

function appendAutoContinueEvent(state: TerminalUiState, event: Extract<RunEvent, { kind: "barrier_reached" }>): void {
  if (state.barrierMode !== "auto_continue") {
    return
  }

  const completed = event.barrier.completed
  if (completed === null || completed === undefined) {
    return
  }

  const label = formatBarrierFrontier(event.barrier.next)
  if (label === null) {
    return
  }

  const completedOutput = ensureCompletedOutput(state, completed.node_path)
  completedOutput.entries.push({
    key: null,
    text: `auto-continue: Next: ${label}`,
    variant: "event",
  })
}

function ensureCompletedOutput(state: TerminalUiState, nodePath: string): CompletedOutput {
  const existing = state.completedOutputs[nodePath]
  if (existing !== undefined) {
    return existing
  }

  const node = state.snapshot?.nodes.find((candidate) => candidate.node_path === nodePath)
  const completedOutput: CompletedOutput = {
    entries: [],
    preview: node ? previewNodeOutput(node) : null,
  }
  state.completedOutputs[nodePath] = completedOutput
  return completedOutput
}

function formatBarrierFrontier(next: FrontierNode[]): string | null {
  if (next.length === 0) {
    return null
  }

  return next.map((node) => formatFrontierNodeLabel(node)).join(", ")
}

function formatFrontierNodeLabel(node: FrontierNode): string {
  const parts = [`${node.user_id ?? node.node_path} [${FRONTIER_KIND_LABELS[node.node_kind] ?? node.node_kind}]`]

  if (node.node_kind === "codex" && node.action) {
    parts.push(node.action)
  }
  if (node.node_kind === "codex" && node.model) {
    parts.push(node.model)
  }

  return parts.join(" · ")
}

function appendLiveStream(state: TerminalUiState, nodePath: string, chunk: string, stream: StreamKind): void {
  const liveOutput = ensureLiveOutput(state, nodePath)
  const lastEntry = liveOutput.entries.at(-1)
  if (lastEntry !== undefined && lastEntry.variant === "stream" && lastEntry.stream === stream) {
    lastEntry.text += chunk
    return
  }

  liveOutput.entries.push({
    key: null,
    stream,
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

  const liveOutput: ActiveLiveOutput = { entries: [] }
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
