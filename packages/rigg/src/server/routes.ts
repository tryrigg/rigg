import { lstat } from "node:fs/promises"
import { join, resolve } from "node:path"

import { Hono, type Context } from "hono"
import { z } from "zod"

import { createRegistry, resolveImmediate } from "../cli/control"
import { createRecorder } from "../history/record"
import { getRunView, listHistory } from "../history/query"
import { serializeRun, serializeRunSummary } from "../history/serialize"
import { type PendingInteraction, RunStatusSchema, type RunSnapshot, type RunStatus } from "../session/schema"
import { runWorkflow } from "../session/api"
import type { RunEvent } from "../session/event"
import type { InteractionResolution } from "../session/interaction"
import { snapEvent } from "../session/snap"
import { loadProject, scanProject } from "../project"
import { findWorkspaceId } from "../project/store"
import { closeDb, openDb } from "../storage/db"
import type { RecordingStatus } from "../history/history.sql"
import { createEventStream, type ServerDoneStatus, type ServerEvent } from "./events"
import { normalizeError } from "../util/error"

const RootHeader = "x-rigg-root"

const RunsQuerySchema = z.object({
  limit: z.coerce.number().int().nonnegative().default(10),
  offset: z.coerce.number().int().nonnegative().default(0),
  status: RunStatusSchema.optional(),
  workflow_id: z.string().min(1).optional(),
})

const StartRunBodySchema = z.object({
  inputs: z.record(z.string(), z.unknown()).default({}),
  workflow_id: z.string().min(1),
})

const ApprovalBodySchema = z.object({
  decision: z.string().min(1),
})

const UserInputBodySchema = z.object({
  answers: z.record(
    z.string(),
    z.object({
      answers: z.array(z.string()),
    }),
  ),
})

const ElicitationBodySchema = z.object({
  _meta: z.unknown().optional(),
  action: z.enum(["accept", "cancel", "decline"]),
  content: z.unknown().optional(),
})

export type ResolveOutcome =
  | { kind: "ok" }
  | { kind: "invalid_body"; message: string }
  | { kind: "not_found"; message: string }

export type ActiveRun = {
  abort: AbortController
  resolveInteraction: (interactionId: string, body: unknown) => ResolveOutcome
  rootDir: string
  runId: string
  snapshot: () => ReturnType<typeof serializeSnapshot> | null
  status: () => RunStatus | null
  subscribe: (send: (event: ServerEvent) => void) => () => void
}

export type ServerState = {
  activeRuns: Map<string, ActiveRun>
  tasks: Set<Promise<void>>
}

type Dependencies = {
  createRecorderImpl: typeof createRecorder
  loadProjectImpl: typeof loadProject
  openDbImpl: typeof openDb
  runWorkflowImpl: typeof runWorkflow
  scanProjectImpl: typeof scanProject
}

const defaultDeps: Dependencies = {
  createRecorderImpl: createRecorder,
  loadProjectImpl: loadProject,
  openDbImpl: openDb,
  runWorkflowImpl: runWorkflow,
  scanProjectImpl: scanProject,
}

function err(code: string, message: string) {
  return { error: { code, message } }
}

function jsonError(status: number, code: string, message: string) {
  return Response.json(err(code, message), { status })
}

function runEvent(event: RunEvent): ServerEvent {
  switch (event.kind) {
    case "barrier_reached":
    case "barrier_resolved":
      return { event, kind: "barrier" }
    case "interaction_requested":
    case "interaction_resolved":
      return { event, kind: "interaction" }
    case "node_completed":
    case "node_retrying":
    case "node_skipped":
    case "node_started":
    case "provider_event":
    case "run_finished":
    case "run_started":
    case "step_output":
      return { event, kind: "run" }
  }
}

function terminal(status: RunStatus): ServerDoneStatus | null {
  if (status === "aborted" || status === "failed" || status === "succeeded") {
    return status
  }

  return null
}

function durationMs(startedAt: string, finishedAt: string | null): number | null {
  if (finishedAt === null) {
    return null
  }

  return Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime())
}

function serializeSnapshot(snapshot: RunSnapshot) {
  return {
    duration_ms: durationMs(snapshot.started_at, snapshot.finished_at ?? null),
    finished_at: snapshot.finished_at ?? null,
    nodes: snapshot.nodes.map((node) => ({
      attempt: node.attempt,
      duration_ms: node.duration_ms ?? null,
      exit_code: node.exit_code ?? null,
      finished_at: node.finished_at ?? null,
      node_kind: node.node_kind,
      node_path: node.node_path,
      result_json: node.result === undefined || node.result === null ? null : JSON.stringify(node.result),
      started_at: node.started_at ?? null,
      status: node.status,
      stderr_path: null,
      stderr_preview: typeof node.stderr === "string" ? node.stderr : null,
      stdout_path: null,
      stdout_preview: typeof node.stdout === "string" ? node.stdout : null,
      user_id: node.user_id ?? null,
    })),
    reason: snapshot.reason ?? null,
    recording_status: "partial" as RecordingStatus,
    run_id: snapshot.run_id,
    short_id: snapshot.run_id.slice(0, 8),
    started_at: snapshot.started_at,
    status: snapshot.status,
    workflow_id: snapshot.workflow_id,
  }
}

function decodeInteraction(
  interaction: PendingInteraction,
  body: unknown,
): ResolveOutcome | { kind: "parsed"; resolution: InteractionResolution } {
  switch (interaction.kind) {
    case "approval": {
      const parsed = ApprovalBodySchema.safeParse(body)
      if (!parsed.success) {
        return { kind: "invalid_body", message: "approval resolution body must include a decision string." }
      }

      if (interaction.request.kind !== "approval") {
        return { kind: "invalid_body", message: "approval interaction payload did not match the pending request." }
      }

      if (!interaction.request.decisions.some((decision) => decision.value === parsed.data.decision)) {
        return {
          kind: "invalid_body",
          message: `approval decision ${parsed.data.decision} is not valid for interaction ${interaction.interaction_id}.`,
        }
      }

      return { kind: "parsed", resolution: { decision: parsed.data.decision, kind: "approval" } }
    }
    case "user_input": {
      const parsed = UserInputBodySchema.safeParse(body)
      if (!parsed.success) {
        return { kind: "invalid_body", message: "user_input resolution body must include an answers object." }
      }
      return { kind: "parsed", resolution: { answers: parsed.data.answers, kind: "user_input" } }
    }
    case "elicitation": {
      const parsed = ElicitationBodySchema.safeParse(body)
      if (!parsed.success) {
        return {
          kind: "invalid_body",
          message: "elicitation resolution body must include an action of accept, cancel, or decline.",
        }
      }
      return { kind: "parsed", resolution: { ...parsed.data, kind: "elicitation" } }
    }
  }
}

async function readBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch (error) {
    throw new Error(`failed to read request body: ${normalizeError(error).message}`)
  }
}

function track(state: ServerState, task: Promise<void>) {
  state.tasks.add(task)
  void task.finally(() => {
    state.tasks.delete(task)
  })
}

async function startRun(
  state: ServerState,
  rootDir: string,
  input: z.infer<typeof StartRunBodySchema>,
  deps: Dependencies,
): Promise<
  | { kind: "invalid"; messages: string[] }
  | { kind: "ok"; run: ActiveRun; snapshot: ReturnType<typeof serializeSnapshot> }
> {
  const projectResult = await deps.loadProjectImpl(rootDir)
  if (projectResult.kind === "not_found") {
    return { kind: "invalid", messages: ["Could not find a .rigg directory from the supplied root."] }
  }
  if (projectResult.kind === "invalid") {
    return { kind: "invalid", messages: projectResult.errors.map((item) => item.message) }
  }

  const recorder = await deps.createRecorderImpl({
    workflowId: input.workflow_id,
    workspace: projectResult.project.workspace,
  })
  const registry = createRegistry()
  const waiting = new Map<string, PendingInteraction>()
  const subscribers = new Set<(event: ServerEvent) => void>()
  const abort = new AbortController()
  let doneSent = false
  let rejectStart = (_error: Error) => {}
  let resolveStart = (_snapshot: RunSnapshot) => {}
  const started = new Promise<RunSnapshot>((resolve, reject) => {
    resolveStart = resolve
    rejectStart = reject
  })
  let snapshot: RunSnapshot | null = null
  let status: RunStatus | null = null

  const active: ActiveRun = {
    abort,
    resolveInteraction: (interactionId, body) => {
      const interaction = waiting.get(interactionId)
      if (interaction === undefined) {
        return {
          kind: "not_found",
          message: `interaction ${interactionId} was not found for run ${active.runId}.`,
        }
      }

      const parsed = decodeInteraction(interaction, body)
      if (parsed.kind !== "parsed") {
        return parsed
      }

      waiting.delete(interactionId)
      registry.resolveInteraction(interactionId, parsed.resolution)
      return { kind: "ok" }
    },
    rootDir,
    runId: "",
    snapshot: () => (snapshot === null ? null : serializeSnapshot(snapshot)),
    status: () => status,
    subscribe: (send) => {
      subscribers.add(send)
      return () => {
        subscribers.delete(send)
      }
    },
  }

  const emit = (event: ServerEvent) => {
    for (const send of subscribers) {
      send(event)
    }
  }

  const sendDone = (next: RunStatus | null) => {
    if (doneSent || next === null) {
      return
    }

    const resolved = terminal(next)
    if (resolved === null) {
      return
    }

    doneSent = true
    emit({ kind: "done", status: resolved })
  }

  const task = (async () => {
    try {
      const result = await deps.runWorkflowImpl({
        controlHandler: async (request) => {
          if (request.kind === "step_barrier") {
            return { action: "continue", kind: "step_barrier" }
          }

          const immediate = resolveImmediate(request)
          if (immediate !== null) {
            return immediate
          }

          waiting.set(request.interaction.interaction_id, request.interaction)
          try {
            return await registry.register(request)
          } finally {
            waiting.delete(request.interaction.interaction_id)
          }
        },
        invocationInputs: input.inputs,
        onEvent: (raw) => {
          const event = snapEvent(raw)
          if (event.kind === "run_started") {
            snapshot = event.snapshot
            status = event.snapshot.status
            active.runId = event.snapshot.run_id
            state.activeRuns.set(active.runId, active)
            resolveStart(event.snapshot)
          }
          if ("snapshot" in event) {
            snapshot = event.snapshot
            status = event.snapshot.status
          }
          emit(runEvent(event))
          recorder.emit(event)
          if (event.kind === "run_finished") {
            sendDone(event.snapshot.status)
          }
        },
        parentEnv: process.env,
        project: projectResult.project,
        signal: abort.signal,
        workflowId: input.workflow_id,
      })

      if (result.kind === "workflow_not_found") {
        rejectStart(new Error(result.message))
        return
      }
      if (result.kind === "invalid_input") {
        rejectStart(new Error(result.errors.join("\n")))
        return
      }
    } catch (error) {
      rejectStart(normalizeError(error))
      sendDone(status)
    } finally {
      registry.clear("run session closed")
      await recorder.close()
      if (active.runId.length > 0) {
        state.activeRuns.delete(active.runId)
      }
      subscribers.clear()
    }
  })()
  track(state, task)

  try {
    const first = await started
    return { kind: "ok", run: active, snapshot: serializeSnapshot(first) }
  } catch (error) {
    abort.abort("run startup failed")
    await task
    return { kind: "invalid", messages: [normalizeError(error).message] }
  }
}

async function resolveRoot(header: string | undefined) {
  if (header === undefined || header.trim().length === 0) {
    return { kind: "missing" as const }
  }

  const root = resolve(header)

  try {
    const stat = await lstat(root)
    if (!stat.isDirectory()) {
      return { kind: "invalid" as const, root }
    }
  } catch {
    return { kind: "invalid" as const, root }
  }

  try {
    const stat = await lstat(join(root, ".rigg"))
    if (!stat.isDirectory()) {
      return { kind: "missing_rigg" as const, root }
    }
  } catch {
    return { kind: "missing_rigg" as const, root }
  }

  return { kind: "ok" as const, root }
}

async function resolveWorkspace(
  c: Context,
  deps: Dependencies,
): Promise<{ kind: "error"; response: Response } | { kind: "ok"; rootDir: string; workspaceId: string }> {
  const rootResult = await resolveRoot(c.req.header(RootHeader))
  if (rootResult.kind === "missing") {
    return { kind: "error", response: jsonError(400, "missing_root", `missing ${RootHeader} header.`) }
  }
  if (rootResult.kind === "invalid") {
    return {
      kind: "error",
      response: jsonError(400, "invalid_root", `project root ${rootResult.root} does not exist or is not a directory.`),
    }
  }
  if (rootResult.kind === "missing_rigg") {
    return {
      kind: "error",
      response: jsonError(
        404,
        "workspace_not_found",
        `project root ${rootResult.root} does not contain a .rigg directory.`,
      ),
    }
  }

  const openResult = await deps.openDbImpl()
  if (openResult.kind !== "ok") {
    return {
      kind: "error",
      response: jsonError(503, "history_unavailable", openResult.warning.join(" ")),
    }
  }

  try {
    const workspaceId = findWorkspaceId(openResult.db, rootResult.root)
    if (workspaceId === null) {
      return {
        kind: "error",
        response: jsonError(
          404,
          "workspace_not_found",
          `failed to resolve workspace for root ${rootResult.root}: no workspace history exists yet. Start a run from this workspace, then retry.`,
        ),
      }
    }

    return { kind: "ok", rootDir: rootResult.root, workspaceId }
  } finally {
    closeDb(openResult.db)
  }
}

function activeSummary(active: ActiveRun) {
  const run = active.snapshot()
  if (run === null) {
    return null
  }

  return {
    duration_ms: run.duration_ms,
    finished_at: run.finished_at,
    reason: run.reason,
    recording_status: run.recording_status,
    run_id: run.run_id,
    short_id: run.short_id,
    started_at: run.started_at,
    status: run.status,
    workflow_id: run.workflow_id,
  }
}

function hasRunSummary(item: ReturnType<typeof activeSummary>): item is NonNullable<ReturnType<typeof activeSummary>> {
  return item !== null
}

async function knownRun(deps: Dependencies, runId: string): Promise<"historical" | "missing"> {
  const openResult = await deps.openDbImpl()
  if (openResult.kind !== "ok") {
    return "missing"
  }

  try {
    return getRunView(openResult.db, runId) === null ? "missing" : "historical"
  } finally {
    closeDb(openResult.db)
  }
}

export function createState(): ServerState {
  return {
    activeRuns: new Map(),
    tasks: new Set(),
  }
}

export async function closeState(state: ServerState): Promise<void> {
  for (const run of state.activeRuns.values()) {
    run.abort.abort("server shutting down")
  }
  await Promise.allSettled([...state.tasks])
}

export function createApp(state: ServerState, overrides: Partial<Dependencies> = {}): Hono {
  const deps = { ...defaultDeps, ...overrides }
  const app = new Hono()

  app.get("/healthz", (c) => c.json({ ok: true }))

  app.get("/api/workflows", async (c) => {
    const workspace = await resolveWorkspace(c, deps)
    if (workspace.kind === "error") {
      return workspace.response
    }

    const result = await deps.scanProjectImpl(workspace.rootDir)
    if (result.kind === "not_found") {
      return jsonError(
        404,
        "workspace_not_found",
        `project root ${workspace.rootDir} does not contain a .rigg directory.`,
      )
    }
    if (result.kind === "invalid") {
      return jsonError(400, "invalid_project", result.errors.map((item) => item.message).join("\n"))
    }

    return c.json({
      errors: result.errors.map((item) => item.message),
      workflows: result.project.files.map((file) => ({
        path: file.relativePath,
        workflow_id: file.workflow.id,
      })),
    })
  })

  app.get("/api/runs", async (c) => {
    const workspace = await resolveWorkspace(c, deps)
    if (workspace.kind === "error") {
      return workspace.response
    }

    const query = RunsQuerySchema.safeParse(c.req.query())
    if (!query.success) {
      return jsonError(400, "invalid_query", query.error.issues.map((item) => item.message).join("\n"))
    }

    const openResult = await deps.openDbImpl()
    if (openResult.kind !== "ok") {
      return jsonError(503, "history_unavailable", openResult.warning.join(" "))
    }

    try {
      const runs = listHistory(openResult.db, {
        limit: query.data.limit,
        offset: query.data.offset,
        ...(query.data.status === undefined ? {} : { status: query.data.status }),
        ...(query.data.workflow_id === undefined ? {} : { workflowId: query.data.workflow_id }),
        workspaceId: workspace.workspaceId,
      }).map(serializeRunSummary)

      const live = [...state.activeRuns.values()]
        .filter((run) => run.rootDir === workspace.rootDir)
        .map(activeSummary)
        .filter(hasRunSummary)
        .filter((item) => (query.data.workflow_id === undefined ? true : item.workflow_id === query.data.workflow_id))
        .filter((item) => (query.data.status === undefined ? true : item.status === query.data.status))

      const merged = [...runs]
      for (const item of live) {
        if (!merged.some((existing) => existing.run_id === item.run_id)) {
          merged.push(item)
        }
      }

      merged.sort(
        (left, right) => right.started_at.localeCompare(left.started_at) || right.run_id.localeCompare(left.run_id),
      )

      return c.json({
        runs: merged.slice(query.data.offset, query.data.offset + query.data.limit),
      })
    } finally {
      closeDb(openResult.db)
    }
  })

  app.post("/api/runs", async (c) => {
    const workspace = await resolveWorkspace(c, deps)
    if (workspace.kind === "error") {
      return workspace.response
    }

    let body: unknown
    try {
      body = await readBody(c.req.raw)
    } catch (error) {
      return jsonError(400, "invalid_body", normalizeError(error).message)
    }

    const parsed = StartRunBodySchema.safeParse(body)
    if (!parsed.success) {
      return jsonError(400, "invalid_body", parsed.error.issues.map((item) => item.message).join("\n"))
    }

    const started = await startRun(state, workspace.rootDir, parsed.data, deps)
    if (started.kind !== "ok") {
      return jsonError(400, "invalid_run", started.messages.join("\n"))
    }

    return c.json({ run: started.snapshot }, 202)
  })

  app.get("/api/runs/:runId", async (c) => {
    const runId = c.req.param("runId")
    const active = state.activeRuns.get(runId)
    if (active !== undefined) {
      return c.json({ run: active.snapshot() })
    }

    const openResult = await deps.openDbImpl()
    if (openResult.kind !== "ok") {
      return jsonError(503, "history_unavailable", openResult.warning.join(" "))
    }

    try {
      const run = getRunView(openResult.db, runId)
      if (run === null) {
        return jsonError(404, "run_not_found", `run ${runId} was not found.`)
      }

      return c.json({ run: serializeRun(run) })
    } finally {
      closeDb(openResult.db)
    }
  })

  app.get("/api/runs/:runId/events", async (c) => {
    const runId = c.req.param("runId")
    const active = state.activeRuns.get(runId)
    if (active !== undefined) {
      const run = active.snapshot()
      if (run === null) {
        return jsonError(404, "run_not_found", `run ${runId} was not found.`)
      }

      return createEventStream({
        active,
        run,
        signal: c.req.raw.signal,
        status: active.status(),
      })
    }

    const openResult = await deps.openDbImpl()
    if (openResult.kind !== "ok") {
      return jsonError(503, "history_unavailable", openResult.warning.join(" "))
    }

    try {
      const run = getRunView(openResult.db, runId)
      if (run === null) {
        return jsonError(404, "run_not_found", `run ${runId} was not found.`)
      }

      return createEventStream({
        run: serializeRun(run),
        signal: c.req.raw.signal,
        status: run.status,
      })
    } finally {
      closeDb(openResult.db)
    }
  })

  app.post("/api/runs/:runId/abort", async (c) => {
    const runId = c.req.param("runId")
    const active = state.activeRuns.get(runId)
    if (active !== undefined) {
      active.abort.abort(`run ${runId} aborted via HTTP`)
      return c.json({ ok: true }, 202)
    }

    return (await knownRun(deps, runId)) === "historical"
      ? jsonError(
          409,
          "run_not_attached",
          `run ${runId} is not attached to this serve process. Start the run via POST /api/runs on this server, then retry.`,
        )
      : jsonError(404, "run_not_found", `run ${runId} was not found.`)
  })

  app.post("/api/runs/:runId/interactions/:interactionId", async (c) => {
    const runId = c.req.param("runId")
    const interactionId = c.req.param("interactionId")
    const active = state.activeRuns.get(runId)

    let body: unknown
    try {
      body = await readBody(c.req.raw)
    } catch (error) {
      return jsonError(400, "invalid_body", normalizeError(error).message)
    }

    if (active !== undefined) {
      const outcome = active.resolveInteraction(interactionId, body)
      if (outcome.kind === "ok") {
        return c.json({ ok: true }, 202)
      }
      if (outcome.kind === "invalid_body") {
        return jsonError(400, "invalid_body", outcome.message)
      }
      return jsonError(404, "interaction_not_found", outcome.message)
    }

    return (await knownRun(deps, runId)) === "historical"
      ? jsonError(
          409,
          "run_not_attached",
          `run ${runId} is not attached to this serve process. Start the run via POST /api/runs on this server, then retry.`,
        )
      : jsonError(404, "run_not_found", `run ${runId} was not found.`)
  })

  return app
}
