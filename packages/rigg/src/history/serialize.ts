import type { LogEntry, Run, RunLog, RunSummary, Step, StepLog } from "./query"

function serializeLogEntry(entry: LogEntry) {
  return {
    data: entry.data,
    kind: entry.kind,
    seq: entry.seq,
    stream: entry.stream,
    text: entry.text,
  }
}

function serializeStep(step: Step) {
  return {
    attempt: step.attempt,
    duration_ms: step.durationMs,
    exit_code: step.exitCode,
    finished_at: step.finishedAt,
    node_kind: step.nodeKind,
    node_path: step.nodePath,
    result_json: step.resultJson,
    started_at: step.startedAt,
    status: step.status,
    stderr_path: step.stderrPath,
    stderr_preview: step.stderrPreview,
    stdout_path: step.stdoutPath,
    stdout_preview: step.stdoutPreview,
    user_id: step.userId,
  }
}

function serializeStepLog(step: StepLog) {
  return {
    attempt: step.attempt,
    duration_ms: step.durationMs,
    entries: step.entries.map(serializeLogEntry),
    node_kind: step.nodeKind,
    node_path: step.nodePath,
    status: step.status,
    stderr_path: step.stderrPath,
    stderr_preview: step.stderrPreview,
    stdout_path: step.stdoutPath,
    stdout_preview: step.stdoutPreview,
    user_id: step.userId,
  }
}

export function serializeRunSummary(run: RunSummary) {
  return {
    duration_ms: run.durationMs,
    finished_at: run.finishedAt,
    reason: run.reason,
    recording_status: run.recordingStatus,
    run_id: run.runId,
    short_id: run.shortId,
    started_at: run.startedAt,
    status: run.status,
    workflow_id: run.workflowId,
  }
}

export function serializeRun(run: Run) {
  return {
    duration_ms: run.durationMs,
    finished_at: run.finishedAt,
    nodes: run.steps.map(serializeStep),
    reason: run.reason,
    recording_status: run.recordingStatus,
    run_id: run.runId,
    short_id: run.shortId,
    started_at: run.startedAt,
    status: run.status,
    workflow_id: run.workflowId,
  }
}

export function serializeRunLog(run: RunLog) {
  return {
    run_entries: run.runEntries.map(serializeLogEntry),
    steps: run.steps.map(serializeStepLog),
  }
}
