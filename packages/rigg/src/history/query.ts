import { and, asc, desc, eq, gt, gte, lt, notExists, or } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"

import type { NodeStatus, RunReason, RunStatus } from "../session/schema"
import type { Db } from "../storage/db"
import { stringifyOptional } from "../util/json"
import { formatOptionalTimestampMs, formatTimestampMs } from "../util/time"
import { comparePath } from "../workflow/id"
import {
  type EventPayload,
  type EventRow,
  eventTable,
  type RecordingStatus,
  type RunRow,
  runTable,
  type StepPayload,
  type StepRow,
  stepTable,
} from "./history.sql"
import { normalizeRunId, shortRunIdNear } from "./id"

export type HistoryFilter = {
  workspaceId: string
  workflowId?: string
  status?: RunStatus
  limit: number
  offset: number
}

export type RunSummary = {
  durationMs: number | null
  finishedAt: string | null
  reason: RunReason | null
  recordingStatus: RecordingStatus
  runId: string
  shortId: string
  startedAt: string
  status: RunStatus
  workflowId: string
}

export type Step = {
  attempt: number
  durationMs: number | null
  exitCode: number | null
  finishedAt: string | null
  nodeKind: string
  nodePath: string
  resultJson: string | null
  startedAt: string | null
  status: NodeStatus
  stderrPath: string | null
  stderrPreview: string | null
  stdoutPath: string | null
  stdoutPreview: string | null
  userId: string | null
}

export type Run = {
  durationMs: number | null
  finishedAt: string | null
  reason: RunReason | null
  recordingStatus: RecordingStatus
  runId: string
  shortId: string
  startedAt: string
  status: RunStatus
  steps: Step[]
  workflowId: string
}

export type LogEntry = {
  data: unknown
  kind: string
  seq: number
  stream: string | null
  text: string | null
}

export type StepLog = Step & { entries: LogEntry[] }

export type RunLog = {
  durationMs: number | null
  finishedAt: string | null
  reason: RunReason | null
  recordingStatus: RecordingStatus
  runEntries: LogEntry[]
  runId: string
  shortId: string
  startedAt: string
  status: RunStatus
  steps: StepLog[]
  workflowId: string
}

export type StepSelection = { kind: "ok"; steps: Step[] } | { kind: "missing" } | { kind: "ambiguous"; matches: Step[] }

export type LogResolution =
  | { kind: "ok"; view: RunLog }
  | { kind: "missing_step"; run: Run }
  | { kind: "ambiguous_step"; run: Run; matches: Step[] }

export type WorkflowSummary = {
  lastRun: RunSummary | null
  workflowId: string
}

type PrefixResolution =
  | { kind: "ok"; runId: string }
  | { kind: "missing"; recent: RunSummary[] }
  | { kind: "ambiguous"; matches: RunSummary[] }

type HistoryScope = {
  workspaceId: string
  workflowId?: string
  status?: RunStatus
}

type HistoryPage = {
  limit: number
  offset: number
}

function output(payload: StepPayload, key: "stdout" | "stderr") {
  const value = payload[key] ?? null
  return {
    path: value?.path ?? null,
    preview: value?.preview ?? null,
  }
}

function stepFromRow(row: StepRow): Step {
  const stdout = output(row.payload, "stdout")
  const stderr = output(row.payload, "stderr")

  return {
    attempt: row.attempt,
    durationMs: row.durationMs,
    exitCode: row.exitCode,
    finishedAt: formatOptionalTimestampMs(row.finishedAt),
    nodeKind: row.nodeKind,
    nodePath: row.nodePath,
    resultJson: stringifyOptional(row.payload.result),
    startedAt: formatOptionalTimestampMs(row.startedAt),
    status: row.status,
    stderrPath: stderr.path,
    stderrPreview: stderr.preview,
    stdoutPath: stdout.path,
    stdoutPreview: stdout.preview,
    userId: row.userId,
  }
}

function logEntryFromRow(row: EventRow): LogEntry {
  const payload: EventPayload = row.payload ?? {}
  return {
    data: payload.data ?? null,
    kind: row.kind,
    seq: row.seq,
    stream: row.stream,
    text: payload.text ?? null,
  }
}

function summaryFromRunRow(row: RunRow, shortId: string): RunSummary {
  return {
    durationMs: row.durationMs,
    finishedAt: formatOptionalTimestampMs(row.finishedAt),
    reason: row.reason,
    recordingStatus: row.recordingStatus,
    runId: row.id,
    shortId,
    startedAt: formatTimestampMs(row.startedAt),
    status: row.status,
    workflowId: row.workflowId,
  }
}

function runFromRow(row: RunRow, shortId: string, steps: Step[]): Run {
  return {
    durationMs: row.durationMs,
    finishedAt: formatOptionalTimestampMs(row.finishedAt),
    reason: row.reason,
    recordingStatus: row.recordingStatus,
    runId: row.id,
    shortId,
    startedAt: formatTimestampMs(row.startedAt),
    status: row.status,
    steps,
    workflowId: row.workflowId,
  }
}

function stepLog(step: Step, entries: LogEntry[]): StepLog {
  return { ...step, entries }
}

function runLog(run: Run, runEntries: LogEntry[], steps: StepLog[]): RunLog {
  return {
    durationMs: run.durationMs,
    finishedAt: run.finishedAt,
    reason: run.reason,
    recordingStatus: run.recordingStatus,
    runEntries,
    runId: run.runId,
    shortId: run.shortId,
    startedAt: run.startedAt,
    status: run.status,
    steps,
    workflowId: run.workflowId,
  }
}

function formatRunId(id: string): string {
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`
}

function prefixRunId(id: string): string {
  const parts = [8, 4, 4, 4, 12]
  let rest = id
  let out = ""
  for (const len of parts) {
    if (rest.length === 0) {
      return out
    }
    const chunk = rest.slice(0, len)
    out += chunk
    rest = rest.slice(chunk.length)
    if (rest.length === 0 || chunk.length < len) {
      return out
    }
    out += "-"
  }
  return out
}

function selectRunRows(db: Db, scope: HistoryScope, page?: HistoryPage): RunRow[] {
  const clauses = [eq(runTable.workspaceId, scope.workspaceId)]
  if (scope.workflowId !== undefined) {
    clauses.push(eq(runTable.workflowId, scope.workflowId))
  }
  if (scope.status !== undefined) {
    clauses.push(eq(runTable.status, scope.status))
  }

  const query = db
    .select()
    .from(runTable)
    .where(and(...clauses))
    .orderBy(desc(runTable.startedAt), desc(runTable.id))
  if (page === undefined) {
    return query.all()
  }

  return query.limit(page.limit).offset(page.offset).all()
}

function neighbors(db: Db, workspaceId: string, runId: string) {
  const prev = db
    .select({ runId: runTable.id })
    .from(runTable)
    .where(and(eq(runTable.workspaceId, workspaceId), lt(runTable.id, runId)))
    .orderBy(desc(runTable.id))
    .limit(1)
    .get()
  const next = db
    .select({ runId: runTable.id })
    .from(runTable)
    .where(and(eq(runTable.workspaceId, workspaceId), gt(runTable.id, runId)))
    .orderBy(asc(runTable.id))
    .limit(1)
    .get()
  return { next: next?.runId, prev: prev?.runId }
}

function shortId(db: Db, workspaceId: string, runId: string): string {
  const near = neighbors(db, workspaceId, runId)
  return shortRunIdNear(runId, near.prev, near.next)
}

function runSummaries(db: Db, workspaceId: string, rows: RunRow[]): RunSummary[] {
  if (rows.length === 0) {
    return []
  }

  const firstId = rows[0]!.id
  const lastId = rows[rows.length - 1]!.id
  const outerPrev = db
    .select({ runId: runTable.id })
    .from(runTable)
    .where(and(eq(runTable.workspaceId, workspaceId), lt(runTable.id, lastId)))
    .orderBy(desc(runTable.id))
    .limit(1)
    .get()
  const outerNext = db
    .select({ runId: runTable.id })
    .from(runTable)
    .where(and(eq(runTable.workspaceId, workspaceId), gt(runTable.id, firstId)))
    .orderBy(asc(runTable.id))
    .limit(1)
    .get()

  return rows.map((row, index) => {
    const prev = index < rows.length - 1 ? rows[index + 1]!.id : outerPrev?.runId
    const next = index > 0 ? rows[index - 1]!.id : outerNext?.runId
    return summaryFromRunRow(row, shortRunIdNear(row.id, prev, next))
  })
}

function compareStep(left: Step, right: Step): number {
  const pathOrder = comparePath(left.nodePath, right.nodePath)
  if (pathOrder !== 0) {
    return pathOrder
  }
  return left.attempt - right.attempt
}

function buildRun(db: Db, row: RunRow): Run {
  const steps = db.select().from(stepTable).where(eq(stepTable.runId, row.id)).all().map(stepFromRow).sort(compareStep)
  return runFromRow(row, shortId(db, row.workspaceId, row.id), steps)
}

export function resolveStepSelector(steps: Step[], selector: string): StepSelection {
  const exact = steps.filter((step) => step.nodePath === selector).sort(compareStep)
  if (exact.length > 0) {
    return { kind: "ok", steps: exact }
  }

  const matches = new Map<string, Step[]>()
  for (const step of steps) {
    if (step.userId !== selector) {
      continue
    }
    const bucket = matches.get(step.nodePath) ?? []
    bucket.push(step)
    matches.set(step.nodePath, bucket)
  }

  if (matches.size === 0) {
    return { kind: "missing" }
  }
  if (matches.size > 1) {
    return {
      kind: "ambiguous",
      matches: [...matches.values()].map((bucket) => bucket.sort(compareStep)[0]!).sort(compareStep),
    }
  }

  return { kind: "ok", steps: [...matches.values()][0]!.sort(compareStep) }
}

function buildRunLog(db: Db, run: Run, steps: Step[], opts: { includeRunEntries: boolean }): RunLog {
  const rows = db.select().from(eventTable).where(eq(eventTable.runId, run.runId)).orderBy(eventTable.seq).all()

  const runEntries: LogEntry[] = []
  const entriesByStep = new Map<string, LogEntry[]>()
  for (const row of rows) {
    const entry = logEntryFromRow(row)
    if (row.nodePath === null) {
      runEntries.push(entry)
      continue
    }
    const key = `${row.nodePath}#${row.attempt ?? 1}`
    const bucket = entriesByStep.get(key) ?? []
    bucket.push(entry)
    entriesByStep.set(key, bucket)
  }

  return runLog(
    run,
    opts.includeRunEntries ? runEntries : [],
    steps.map((step) => stepLog(step, entriesByStep.get(`${step.nodePath}#${step.attempt}`) ?? [])),
  )
}

export function listHistory(db: Db, filter: HistoryFilter): RunSummary[] {
  return runSummaries(db, filter.workspaceId, selectRunRows(db, filter, filter))
}

export function listRecentRuns(db: Db, workspaceId: string, limit = 3): RunSummary[] {
  return listHistory(db, { limit, offset: 0, workspaceId })
}

export function findLatestRun(db: Db, workspaceId: string, workflowId?: string): RunSummary | null {
  const [item] = listHistory(db, {
    limit: 1,
    offset: 0,
    workspaceId,
    ...(workflowId === undefined ? {} : { workflowId }),
  })
  return item ?? null
}

function selectRunPrefixRows(db: Db, workspaceId: string, normalized: string): RunRow[] {
  if (normalized.length === 32) {
    return db
      .select()
      .from(runTable)
      .where(and(eq(runTable.workspaceId, workspaceId), eq(runTable.id, formatRunId(normalized))))
      .orderBy(desc(runTable.startedAt), desc(runTable.id))
      .all()
  }

  const prefix = prefixRunId(normalized)
  return db
    .select()
    .from(runTable)
    .where(and(eq(runTable.workspaceId, workspaceId), gte(runTable.id, prefix), lt(runTable.id, `${prefix}\uffff`)))
    .orderBy(desc(runTable.startedAt), desc(runTable.id))
    .all()
}

export function getRunByPrefix(db: Db, workspaceId: string, input: string): PrefixResolution {
  const normalized = normalizeRunId(input)
  if (normalized.length === 0 || normalized.length > 32) {
    return { kind: "missing", recent: listRecentRuns(db, workspaceId) }
  }

  const matches = runSummaries(db, workspaceId, selectRunPrefixRows(db, workspaceId, normalized))
  if (matches.length === 0) {
    return { kind: "missing", recent: listRecentRuns(db, workspaceId) }
  }
  if (matches.length > 1) {
    return { kind: "ambiguous", matches }
  }

  return { kind: "ok", runId: matches[0]!.runId }
}

export function getRunView(db: Db, runId: string): Run | null {
  const row = db.select().from(runTable).where(eq(runTable.id, runId)).get()
  if (row === undefined) {
    return null
  }

  return buildRun(db, row)
}

export function resolveLogView(db: Db, runId: string, stepName?: string): LogResolution | null {
  const run = getRunView(db, runId)
  if (run === null) {
    return null
  }

  if (stepName === undefined) {
    return { kind: "ok", view: buildRunLog(db, run, run.steps, { includeRunEntries: true }) }
  }

  const step = resolveStepSelector(run.steps, stepName)
  if (step.kind === "missing") {
    return { kind: "missing_step", run }
  }
  if (step.kind === "ambiguous") {
    return { kind: "ambiguous_step", matches: step.matches, run }
  }

  return {
    kind: "ok",
    view: buildRunLog(db, run, step.steps, { includeRunEntries: false }),
  }
}

export function getLogView(db: Db, runId: string, stepName?: string): RunLog | null {
  const resolved = resolveLogView(db, runId, stepName)
  if (resolved === null || resolved.kind !== "ok") {
    return null
  }

  return resolved.view
}

export function listWorkflowSummaries(db: Db, workspaceId: string): WorkflowSummary[] {
  const newerRun = alias(runTable, "newer_run")
  const rows = db
    .select()
    .from(runTable)
    .where(
      and(
        eq(runTable.workspaceId, workspaceId),
        notExists(
          db
            .select({ runId: newerRun.id })
            .from(newerRun)
            .where(
              and(
                eq(newerRun.workspaceId, runTable.workspaceId),
                eq(newerRun.workflowId, runTable.workflowId),
                or(
                  gt(newerRun.startedAt, runTable.startedAt),
                  and(eq(newerRun.startedAt, runTable.startedAt), gt(newerRun.id, runTable.id)),
                ),
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(runTable.startedAt), desc(runTable.id))
    .all()

  const summaries = runSummaries(db, workspaceId, rows)
  return rows.map((row, index) => ({ lastRun: summaries[index] ?? null, workflowId: row.workflowId }))
}
