import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import type { RunEvent } from "../session/event"
import type { NodeSnapshot, NodeStatus, RunSnapshot } from "../session/schema"
import { compactJson, parseJson, stringifyOptional } from "../util/json"
import {
  type EventPayload,
  type RecordingStatus,
  type RunInsert,
  type StepPayload,
  type StepInsert,
} from "./history.sql"
import { elapsedMs, parseOptionalTimestampMs, parseTimestampMs } from "../util/time"
import { buildOutputPreview, stepOutputPath } from "./output"

type StepState = {
  attempt: number
  durationMs: number | null
  exitCode: number | null
  finishedAt: string | null
  nodeKind: string
  payload: StepPayload
  startedAt: string | null
  status: NodeStatus
  userId: string | null
}

export type PendingEvent = {
  attempt: number | null
  kind: string
  nodePath: string | null
  payload: EventPayload
  stream: string | null
}

type PendingLog = {
  assistantKey: string | null
  attempt: number | null
  kind: string
  nodePath: string | null
  open: boolean
  payload: EventPayload
  stream: string | null
  streamKey: string | null
}

type AssistantEvent =
  | {
      itemId: string | null
      kind: "message_completed" | "message_delta"
      provider: "codex"
      turnId: string
    }
  | {
      kind: "message_completed" | "message_delta"
      messageId: string | null
      provider: "claude"
      sessionId: string
    }
  | {
      kind: "message_delta"
      messageId: string | null
      provider: "cursor"
      sessionId: string
    }

export type WriteBatch = {
  events: PendingEvent[]
  run: RunInsert | null
  steps: Map<string, StepInsert>
}

const batchAssistantKeys = new WeakMap<WriteBatch, (string | null)[]>()

export type BatchState = {
  anonAssistantKey: Map<string, string>
  anonAssistantSeq: number
  currentAttemptByNodePath: Map<string, number>
  openAssistants: Map<string, PendingLog>
  outputRoot: string
  pendingLogs: PendingLog[]
  stepStates: Map<string, StepState>
}

export function createBatch(): WriteBatch {
  const batch = {
    events: [],
    run: null,
    steps: new Map(),
  }
  batchAssistantKeys.set(batch, [])
  return batch
}

export function createState(outputRoot = join(tmpdir(), "rigg-history", Bun.randomUUIDv7())): BatchState {
  return {
    anonAssistantKey: new Map(),
    anonAssistantSeq: 0,
    currentAttemptByNodePath: new Map(),
    openAssistants: new Map(),
    outputRoot,
    pendingLogs: [],
    stepStates: new Map(),
  }
}

function stepKey(nodePath: string, attempt: number): string {
  return `${nodePath}#${attempt}`
}

function jsonValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null
  }
  return parseJson(compactJson(value))
}

function currentAttempt(state: BatchState, nodePath: string): number {
  return state.currentAttemptByNodePath.get(nodePath) ?? 1
}

function ensureStep(
  state: BatchState,
  nodePath: string,
  attempt: number,
  nodeKind: string,
  userId: string | null,
): StepState {
  const found = state.stepStates.get(stepKey(nodePath, attempt))
  if (found !== undefined) {
    return found
  }

  const step: StepState = {
    attempt,
    durationMs: null,
    exitCode: null,
    finishedAt: null,
    nodeKind,
    payload: {
      progress: null,
      result: null,
      stderr: { path: null, preview: null },
      stdout: { path: null, preview: null },
      waiting_for: null,
    },
    startedAt: null,
    status: "pending",
    userId,
  }
  state.stepStates.set(stepKey(nodePath, attempt), step)
  return step
}

function streamEntry(step: StepState, stream: "stdout" | "stderr") {
  return step.payload[stream] ?? { path: null, preview: null }
}

function readPreview(step: StepState, stream: "stdout" | "stderr"): string | null {
  return streamEntry(step, stream).preview
}

function readPath(step: StepState, stream: "stdout" | "stderr"): string | null {
  return streamEntry(step, stream).path
}

function writePreview(step: StepState, stream: "stdout" | "stderr", preview: string | null): void {
  step.payload[stream] = { ...streamEntry(step, stream), preview }
}

function writePath(step: StepState, stream: "stdout" | "stderr", path: string | null): void {
  step.payload[stream] = { ...streamEntry(step, stream), path }
}

function resetOutput(step: StepState, stream: "stdout" | "stderr"): void {
  const path = readPath(step, stream)
  if (path !== null) {
    rmSync(path, { force: true })
  }
  writePath(step, stream, null)
  writePreview(step, stream, null)
}

function persistFullOutput(
  state: BatchState,
  step: StepState,
  runId: string,
  nodePath: string,
  stream: "stdout" | "stderr",
  text: string,
): string {
  if (state.outputRoot === "") {
    throw new Error("missing history output root")
  }

  const path = stepOutputPath(state.outputRoot, runId, nodePath, step.attempt, stream)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, "utf8")
  return path
}

function syncOutput(
  state: BatchState,
  step: StepState,
  runId: string | null,
  nodePath: string,
  stream: "stdout" | "stderr",
  text: string,
): string {
  const preview = buildOutputPreview(text)
  writePreview(step, stream, preview.preview)

  if (!preview.truncated) {
    const path = readPath(step, stream)
    if (path !== null) {
      rmSync(path, { force: true })
      writePath(step, stream, null)
    }
    return preview.preview
  }

  if (runId === null) {
    writePath(step, stream, null)
    return preview.preview
  }

  writePath(step, stream, persistFullOutput(state, step, runId, nodePath, stream, text))
  return preview.preview
}

function appendOutput(
  state: BatchState,
  step: StepState,
  runId: string | null,
  nodePath: string,
  stream: "stdout" | "stderr",
  chunk: string,
): string | null {
  const current = readPreview(step, stream) ?? ""
  const path = readPath(step, stream)
  if (path !== null) {
    appendFileSync(path, chunk, "utf8")
    return null
  }

  const next = `${current}${chunk}`
  const preview = buildOutputPreview(next)
  writePreview(step, stream, preview.preview)
  if (!preview.truncated) {
    return chunk
  }

  if (runId === null) {
    return preview.preview.slice(current.length)
  }

  writePath(step, stream, persistFullOutput(state, step, runId, nodePath, stream, next))
  return preview.preview.slice(current.length)
}

function syncSnapshotOutput(state: BatchState, step: StepState, runId: string | null, node: NodeSnapshot): void {
  const stdout = stringifyOptional(node.stdout)
  const stderr = stringifyOptional(node.stderr)
  if (stdout === null && stderr === null) {
    return
  }

  resetOutput(step, "stdout")
  resetOutput(step, "stderr")

  if (stdout !== null) {
    syncOutput(state, step, runId, node.node_path, "stdout", stdout)
  }
  if (stderr !== null) {
    syncOutput(state, step, runId, node.node_path, "stderr", stderr)
  }
}

function syncStep(state: BatchState, node: NodeSnapshot, runId: string | null, finalOutput = false): StepState {
  state.currentAttemptByNodePath.set(node.node_path, node.attempt)
  const step = ensureStep(state, node.node_path, node.attempt, node.node_kind, node.user_id ?? null)
  step.durationMs = node.duration_ms ?? null
  step.exitCode = node.exit_code ?? null
  step.finishedAt = node.finished_at ?? null
  step.nodeKind = node.node_kind
  step.payload.progress = node.progress ?? null
  step.payload.result = jsonValue(node.result)
  step.payload.waiting_for = node.waiting_for ?? null
  step.startedAt = node.started_at ?? null
  step.status = node.status
  step.userId = node.user_id ?? null
  if (finalOutput) {
    syncSnapshotOutput(state, step, runId, node)
    return step
  }
  const stdout = stringifyOptional(node.stdout)
  if (readPreview(step, "stdout") === null && stdout !== null) {
    syncOutput(state, step, runId, node.node_path, "stdout", stdout)
  }
  const stderr = stringifyOptional(node.stderr)
  if (readPreview(step, "stderr") === null && stderr !== null) {
    syncOutput(state, step, runId, node.node_path, "stderr", stderr)
  }
  return step
}

function runInsert(
  projectId: string,
  workspaceId: string,
  snapshot: RunSnapshot,
  recordingStatus: RecordingStatus,
): RunInsert {
  return {
    durationMs: snapshot.finished_at ? elapsedMs(snapshot.started_at, snapshot.finished_at) : null,
    finishedAt: parseOptionalTimestampMs(snapshot.finished_at ?? null),
    id: snapshot.run_id,
    projectId,
    reason: snapshot.reason ?? null,
    recordingStatus,
    startedAt: parseTimestampMs(snapshot.started_at),
    status: snapshot.status,
    workflowId: snapshot.workflow_id,
    workspaceId,
  }
}

function stepInsert(runId: string, nodePath: string, step: StepState): StepInsert {
  return {
    attempt: step.attempt,
    durationMs: step.durationMs,
    exitCode: step.exitCode,
    finishedAt: parseOptionalTimestampMs(step.finishedAt),
    nodeKind: step.nodeKind,
    nodePath,
    payload: step.payload,
    runId,
    startedAt: parseOptionalTimestampMs(step.startedAt),
    status: step.status,
    userId: step.userId,
  }
}

function toEvent(log: PendingLog): PendingEvent {
  return {
    attempt: log.attempt ?? null,
    kind: log.kind,
    nodePath: log.nodePath,
    payload: log.payload,
    stream: log.stream,
  }
}

function logPayload(log: { payload: EventPayload }): EventPayload {
  return log.payload ?? {}
}

function drainLogs(state: BatchState): PendingLog[] {
  let count = 0
  while (count < state.pendingLogs.length) {
    if (state.pendingLogs[count]!.open) {
      break
    }
    count += 1
  }
  if (count === 0) {
    return []
  }
  const ready = state.pendingLogs.splice(0, count)
  return ready
}

function pushLog(state: BatchState, log: PendingLog): PendingLog[] {
  state.pendingLogs.push(log)
  return drainLogs(state)
}

function queueStream(state: BatchState, draft: PendingEvent, key: string): PendingLog[] {
  const tail = state.pendingLogs.at(-1)
  if (tail !== undefined && !tail.open && tail.kind === "stream" && tail.streamKey === key) {
    const prev = logPayload(tail)
    const next = logPayload(draft)
    tail.payload = {
      ...prev,
      ...next,
      text: `${prev.text ?? ""}${next.text ?? ""}`,
    }
    return drainLogs(state)
  }

  return pushLog(state, {
    ...draft,
    assistantKey: null,
    open: false,
    streamKey: key,
  })
}

function queueEvent(state: BatchState, draft: PendingEvent): PendingLog[] {
  return pushLog(state, {
    ...draft,
    assistantKey: null,
    open: false,
    streamKey: null,
  })
}

function queueAssistant(state: BatchState, draft: PendingEvent, key: string | null, completed: boolean): PendingLog[] {
  if (key !== null) {
    const found = state.openAssistants.get(key)
    if (found !== undefined) {
      const prev = logPayload(found)
      const next = logPayload(draft)
      found.payload = {
        ...prev,
        ...next,
        text: completed ? (next.text ?? "") : `${prev.text ?? ""}${next.text ?? ""}`,
      }
      if (completed) {
        found.open = false
        state.openAssistants.delete(key)
      }
      return drainLogs(state)
    }
  }

  const log: PendingLog = {
    ...draft,
    assistantKey: key,
    open: !completed,
    streamKey: null,
  }
  state.pendingLogs.push(log)
  if (key !== null && !completed) {
    state.openAssistants.set(key, log)
  }
  return drainLogs(state)
}

function assistantKey(state: BatchState, nodePath: string, event: AssistantEvent): string | null {
  if (event.provider === "codex") {
    if (event.itemId !== null) {
      return event.itemId
    }
    const slot = `${nodePath}:${event.turnId}`
    const found = state.anonAssistantKey.get(slot)
    if (found !== undefined) {
      if (event.kind === "message_completed") {
        state.anonAssistantKey.delete(slot)
      }
      return found
    }
    state.anonAssistantSeq += 1
    const key = `${event.turnId}:anon:${state.anonAssistantSeq}`
    if (event.kind !== "message_completed") {
      state.anonAssistantKey.set(slot, key)
    }
    return key
  }

  return event.messageId ?? event.sessionId
}

function addEvents(batch: WriteBatch, drafts: PendingLog[]): void {
  if (drafts.length === 0) {
    return
  }
  const keys = batchAssistantKeys.get(batch) ?? []
  for (const draft of drafts) {
    const last = batch.events.at(-1)
    const lastKey = keys.at(-1)
    if (
      draft.kind === "assistant" &&
      draft.assistantKey !== null &&
      last !== undefined &&
      last.kind === "assistant" &&
      last.attempt === draft.attempt &&
      last.nodePath === draft.nodePath &&
      lastKey === draft.assistantKey
    ) {
      const prev = logPayload(last)
      const next = logPayload(draft)
      last.payload = {
        ...prev,
        ...next,
        text: `${prev.text ?? ""}${next.text ?? ""}`,
      }
      continue
    }
    batch.events.push(toEvent(draft))
    keys.push(draft.assistantKey)
  }
  batchAssistantKeys.set(batch, keys)
}

function setStep(batch: WriteBatch, row: StepInsert): void {
  batch.steps.set(stepKey(row.nodePath, row.attempt), row)
}

export function flushLogs(state: BatchState): PendingEvent[] {
  const drafts = state.pendingLogs.map(toEvent)
  state.pendingLogs.length = 0
  state.openAssistants.clear()
  return drafts
}

export function pushEvent(
  state: BatchState,
  batch: WriteBatch,
  input: {
    event: RunEvent
    projectId: string
    workspaceId: string
    recordingStatus: RecordingStatus
    runId: string | null
  },
): boolean {
  const event = input.event

  switch (event.kind) {
    case "run_started":
      batch.run = runInsert(input.projectId, input.workspaceId, event.snapshot, input.recordingStatus)
      return false
    case "run_finished":
      batch.run = runInsert(input.projectId, input.workspaceId, event.snapshot, input.recordingStatus)
      return false
    case "node_started": {
      const step = syncStep(state, event.node, input.runId)
      if (input.runId !== null) {
        setStep(batch, stepInsert(input.runId, event.node.node_path, step))
      }
      return false
    }
    case "node_completed":
    case "node_skipped": {
      const step = syncStep(state, event.node, input.runId, true)
      if (input.runId !== null) {
        setStep(batch, stepInsert(input.runId, event.node.node_path, step))
      }
      return false
    }
    case "step_output": {
      const attempt = event.attempt ?? currentAttempt(state, event.node_path)
      state.currentAttemptByNodePath.set(event.node_path, attempt)
      const step = ensureStep(state, event.node_path, attempt, "shell", event.user_id)
      step.userId = event.user_id
      const stored = appendOutput(state, step, input.runId, event.node_path, event.stream, event.chunk)
      if (input.runId !== null) {
        setStep(batch, stepInsert(input.runId, event.node_path, step))
      }
      if (stored !== null) {
        addEvents(
          batch,
          queueStream(
            state,
            {
              attempt,
              kind: "stream",
              nodePath: event.node_path,
              payload: {
                data: null,
                text: stored,
                user_id: event.user_id,
              },
              stream: event.stream,
            },
            `${event.node_path}:${attempt}:${event.stream}`,
          ),
        )
      }
      return false
    }
    case "node_retrying":
      addEvents(
        batch,
        queueEvent(state, {
          attempt: event.attempt,
          kind: "event",
          nodePath: event.node_path,
          payload: {
            data: jsonValue({
              delay_ms: event.delay_ms,
              kind: event.kind,
              max_attempts: event.max_attempts,
              next_attempt: event.next_attempt,
              previous_attempts: event.previous_attempts,
            }),
            text: `node retrying: ${event.user_id ?? event.node_path} attempt ${event.next_attempt}/${event.max_attempts}`,
            user_id: event.user_id,
          },
          stream: null,
        }),
      )
      return false
    case "provider_event":
      switch (event.event.kind) {
        case "message_delta":
        case "message_completed":
          addEvents(
            batch,
            queueAssistant(
              state,
              {
                attempt: event.attempt ?? currentAttempt(state, event.node_path),
                kind: "assistant",
                nodePath: event.node_path,
                payload: {
                  data: jsonValue(event.event),
                  text: event.event.text,
                  user_id: event.user_id,
                },
                stream: null,
              },
              assistantKey(state, event.node_path, event.event),
              event.event.kind === "message_completed" || event.event.provider === "cursor",
            ),
          )
          return false
        case "tool_started":
        case "tool_completed":
          addEvents(
            batch,
            queueEvent(state, {
              attempt: event.attempt ?? currentAttempt(state, event.node_path),
              kind: "event",
              nodePath: event.node_path,
              payload: {
                data: jsonValue(event.event),
                text: `${event.event.kind === "tool_started" ? "tool started" : "tool completed"}: ${event.event.tool}${event.event.detail ? ` (${event.event.detail})` : ""}`,
                user_id: event.user_id,
              },
              stream: null,
            }),
          )
          return false
        case "diagnostic":
        case "error":
          addEvents(
            batch,
            queueEvent(state, {
              attempt: event.attempt ?? currentAttempt(state, event.node_path),
              kind: "event",
              nodePath: event.node_path,
              payload: {
                data: jsonValue(event.event),
                text: `${event.event.kind}: ${event.event.message}`,
                user_id: event.user_id,
              },
              stream: null,
            }),
          )
          return false
        case "session_started":
        case "session_completed":
        case "thread_started":
        case "turn_started":
        case "turn_completed":
          return false
      }
      return false
    case "barrier_reached":
      addEvents(
        batch,
        queueEvent(state, {
          attempt: null,
          kind: "event",
          nodePath: event.barrier.completed?.node_path ?? null,
          payload: {
            data: jsonValue(event.barrier),
            text: `barrier reached: ${event.barrier.reason}`,
            user_id: event.barrier.completed?.user_id ?? null,
          },
          stream: null,
        }),
      )
      return false
    case "barrier_resolved":
      addEvents(
        batch,
        queueEvent(state, {
          attempt: null,
          kind: "event",
          nodePath: null,
          payload: {
            data: { action: event.action, barrier_id: event.barrier_id },
            text: `barrier resolved: ${event.action}`,
            user_id: null,
          },
          stream: null,
        }),
      )
      return false
    case "interaction_requested":
      addEvents(
        batch,
        queueEvent(state, {
          attempt: null,
          kind: "event",
          nodePath: event.interaction.node_path ?? null,
          payload: {
            data: jsonValue(event.interaction),
            text: `interaction requested: ${event.interaction.kind}`,
            user_id: event.interaction.user_id ?? null,
          },
          stream: null,
        }),
      )
      return false
    case "interaction_resolved":
      addEvents(
        batch,
        queueEvent(state, {
          attempt: null,
          kind: "event",
          nodePath: null,
          payload: {
            data: jsonValue(event.resolution),
            text: `interaction resolved: ${event.resolution.kind}`,
            user_id: null,
          },
          stream: null,
        }),
      )
      return false
  }
}
