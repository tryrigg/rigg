import type { WorkspacePaths } from "../project"
import type { RunEvent } from "../session/event"
import { ensureWorkspace } from "../project/store"
import { closeDb, openDb, type Db } from "../storage/db"
import { normalizeError } from "../util/error"
import { resolveOutputRoot } from "./output"
import { createBatch, createState, flushLogs, pushEvent, type BatchState } from "./batch"
import type { RecordingStatus } from "./history.sql"
import { updateRecordingStatus, writeBatch } from "./store"

const MAX_QUEUE_LENGTH = 2048

type RecorderOptions = {
  workflowId: string
  workspace: WorkspacePaths
}

type RecorderResult = {
  recording_status: RecordingStatus
  warnings: string[]
}

type Recorder = {
  close(): Promise<RecorderResult>
  emit(event: RunEvent): void
}

type MutableRecorderState = {
  closed: boolean
  disabled: boolean
  flushing: boolean
  hasPersistedData: boolean
  batch: BatchState
  partial: boolean
  projectId: string
  workspaceId: string
  queue: RunEvent[]
  runId: string | null
  seq: number
  db: Db
  timer: ReturnType<typeof setTimeout> | null
  warnings: string[]
}

function disabledRecorder(warnings: string[]): Recorder {
  return {
    async close() {
      return { recording_status: "disabled", warnings }
    },
    emit() {},
  }
}

function currentRecordingStatus(state: MutableRecorderState): RecordingStatus {
  if (state.disabled && !state.hasPersistedData) {
    return "disabled"
  }
  if (state.partial || state.disabled) {
    return "partial"
  }
  return "complete"
}

function markPartial(state: MutableRecorderState, warning?: string[]): void {
  state.partial = true
  if (warning !== undefined) {
    for (const line of warning) {
      if (!state.warnings.includes(line)) {
        state.warnings.push(line)
      }
    }
  }
}

function markDbFailure(state: MutableRecorderState, message: string): void {
  state.disabled = true
  if (state.hasPersistedData) {
    markPartial(state, [
      `⚠ Run history became unavailable during execution: ${message}`,
      "  This run was recorded partially.",
    ])
    return
  }

  state.warnings.push(
    `⚠ Run history unavailable: ${message}`,
    "  Runs will still execute but this run will not be recorded.",
  )
}

function scheduleFlush(state: MutableRecorderState): void {
  if (state.timer !== null || state.flushing || state.disabled) {
    return
  }

  state.timer = setTimeout(() => {
    state.timer = null
    flushQueue(state)
  }, 50)
}

function drainQueue(state: MutableRecorderState): RunEvent[] {
  return state.queue.splice(0, state.queue.length)
}

function updateRunId(state: MutableRecorderState, events: RunEvent[]): void {
  for (const event of events) {
    if (event.kind === "run_started") {
      state.runId = event.snapshot.run_id
    }
  }
}

function buildPendingBatch(state: MutableRecorderState, events: RunEvent[]) {
  const pending = createBatch()
  for (const event of events) {
    if (
      pushEvent(state.batch, pending, {
        event,
        projectId: state.projectId,
        workspaceId: state.workspaceId,
        recordingStatus: currentRecordingStatus(state),
        runId: state.runId,
      })
    ) {
      state.partial = true
    }
  }
  return pending
}

function persistPendingBatch(state: MutableRecorderState, pending: ReturnType<typeof createBatch>): void {
  const steps = [...pending.steps.values()]
  if (state.runId === null || (pending.run === null && steps.length === 0 && pending.events.length === 0)) {
    return
  }

  state.seq = writeBatch(state.db, {
    events: pending.events,
    run: pending.run,
    runId: state.runId,
    seq: state.seq,
    steps,
  })
  state.hasPersistedData = true
}

function flushQueue(state: MutableRecorderState): void {
  if (state.flushing || state.disabled) {
    return
  }
  if (state.queue.length === 0) {
    return
  }

  state.flushing = true
  const events = drainQueue(state)
  updateRunId(state, events)

  try {
    persistPendingBatch(state, buildPendingBatch(state, events))
  } catch (error) {
    markDbFailure(state, normalizeError(error).message)
  } finally {
    state.flushing = false
  }
}

function persistRecordingStatus(state: MutableRecorderState): void {
  if (state.runId === null) {
    return
  }

  try {
    updateRecordingStatus(state.db, state.runId, currentRecordingStatus(state))
  } catch (error) {
    markDbFailure(state, normalizeError(error).message)
  }
}

async function closeRecorder(state: MutableRecorderState): Promise<RecorderResult> {
  state.closed = true
  if (state.timer !== null) {
    clearTimeout(state.timer)
    state.timer = null
  }

  flushQueue(state)

  if (!state.disabled && state.runId !== null) {
    const finalEvents = flushLogs(state.batch)
    try {
      if (finalEvents.length > 0) {
        state.seq = writeBatch(state.db, {
          events: finalEvents,
          run: null,
          runId: state.runId,
          seq: state.seq,
          steps: [],
        })
        state.hasPersistedData = true
      }
    } catch (error) {
      markDbFailure(state, normalizeError(error).message)
    }
  }

  persistRecordingStatus(state)

  closeDb(state.db)
  return {
    recording_status: currentRecordingStatus(state),
    warnings: state.warnings,
  }
}

export async function createRecorder(options: RecorderOptions): Promise<Recorder> {
  const openResult = await openDb()
  if (openResult.kind !== "ok") {
    return disabledRecorder(openResult.warning)
  }

  try {
    const workspaceRef = ensureWorkspace(openResult.db, options.workspace)
    const state: MutableRecorderState = {
      closed: false,
      disabled: false,
      flushing: false,
      hasPersistedData: false,
      batch: createState(resolveOutputRoot()),
      partial: false,
      projectId: workspaceRef.projectId,
      workspaceId: workspaceRef.workspaceId,
      queue: [],
      runId: null,
      seq: 0,
      db: openResult.db,
      timer: null,
      warnings: [],
    }

    return {
      async close() {
        return await closeRecorder(state)
      },
      emit(event) {
        if (state.closed || state.disabled) {
          return
        }
        if (state.queue.length >= MAX_QUEUE_LENGTH) {
          flushQueue(state)
        }
        if (state.disabled) {
          return
        }
        if (state.queue.length >= MAX_QUEUE_LENGTH) {
          markPartial(state, ["⚠ Run history fell behind during execution.", "  This run was recorded partially."])
          return
        }
        state.queue.push(event)
        scheduleFlush(state)
      },
    }
  } catch (error) {
    closeDb(openResult.db)
    return disabledRecorder([
      `⚠ Run history unavailable: ${normalizeError(error).message}`,
      "  Runs will still execute but this run will not be recorded.",
    ])
  }
}
