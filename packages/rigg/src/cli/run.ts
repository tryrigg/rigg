import { createRecorder } from "../history/record"
import { formatDurationText } from "../history/render"
import { loadProject, workflowById, type WorkflowProject } from "../project"
import { runWorkflow, type RunEvent } from "../session"
import { interrupt } from "../session/error"
import { findOmitted, mergePrompted, parseEntries } from "../session/input"
import type { UserInputQuestion, UserInputResolution } from "../session/interaction"
import { snapEvent } from "../session/snap"
import { initRunState } from "../session/state"
import type { NodeSnapshot, RunReason, RunSnapshot } from "../session/schema"
import { defaults, type InputDefinition } from "../workflow/input"
import type { WorkflowDocument } from "../workflow/schema"
import { normalizeError } from "../util/error"
import { compactJson, deepEqual, safeParseJson, stringifyOptional } from "../util/json"
import { elapsedMs } from "../util/time"
import type { RunMode } from "./args"
import { formatLoopReason, renderErrors } from "./out"
import { type CommandResult, failure, PROJECT_NOT_FOUND_MESSAGE, success } from "./result"
import { createHeadless, createInkSession, type RunSession } from "./session"

const RUN_REASON_MESSAGES = {
  aborted: "Workflow aborted.",
  completed: "Workflow completed.",
  engine_error: "Workflow failed due to an engine error.",
  evaluation_error: "Workflow failed due to an evaluation error.",
  step_failed: "Workflow failed because a step failed.",
  step_timed_out: "Workflow failed because a step timed out.",
  validation_error: "Workflow failed due to a validation error.",
} satisfies Record<RunReason, string>

export type InterruptController = {
  dispose: () => void
  interrupt: () => void
  signal: AbortSignal
}

export type WorkflowStepSummary = {
  attempt: number
  durationMs: number | null
  exitCode: number | null
  finishedAt: string | null
  id: string | null
  kind: string
  path: string
  result: unknown | null
  startedAt: string | null
  status: NodeSnapshot["status"]
  waitingFor: NodeSnapshot["waiting_for"] | null
}

export type WorkflowResultSummary = {
  durationMs: number | null
  error: string | null
  finishedAt: string | null
  phase: RunSnapshot["phase"]
  reason: RunReason | null
  result: unknown | null
  runId: string
  startedAt: string
  status: RunSnapshot["status"]
  steps: WorkflowStepSummary[]
  workflowId: string
}

export type RunCommandOptions = {
  autoContinue: boolean
  inputs: string[]
  mode: RunMode
}

type OutputWriter = {
  emit: (event: RunEvent) => void
  finalSnapshot: () => RunSnapshot | null
  finish: (snapshot: RunSnapshot, summary: WorkflowResultSummary) => void
  replayFinalError: () => boolean
  replayFinalResult: () => boolean
}

type InputResult = { kind: "ready"; inputs: Record<string, unknown> } | { kind: "missing_inputs"; message: string }
type NodeRef = {
  node_path: string
  user_id?: string | null | undefined
}
type OutputWriterOptions = {
  mode: RunMode
}
type OutputIo = {
  writeStderr: (text: string) => void
  writeStdout: (text: string) => void
}
type SessionOptions = {
  autoContinue: boolean
  mode: RunMode
}
type SessionDeps = {
  createHeadlessSession: typeof createHeadless
  createRunSession: typeof createInkSession
}

export function createInterrupt(): InterruptController {
  const controller = new AbortController()

  const onSigint = () => {
    if (!controller.signal.aborted) {
      controller.abort(interrupt("workflow interrupted by operator"))
      return
    }

    process.off("SIGINT", onSigint)
    process.kill(process.pid, "SIGINT")
  }

  process.on("SIGINT", onSigint)
  return {
    dispose: () => process.off("SIGINT", onSigint),
    interrupt: onSigint,
    signal: controller.signal,
  }
}

export type Dependencies = {
  createHeadlessSession: typeof createHeadless
  createRecorderImpl: typeof createRecorder
  createInterruptController: () => InterruptController
  createRunSession: typeof createInkSession
  loadProjectImpl: typeof loadProject
  now: () => string
  runWorkflowImpl: typeof runWorkflow
  writeStderr: (text: string) => void
  writeStdout: (text: string) => void
}

const defaultDependencies: Dependencies = {
  createHeadlessSession: createHeadless,
  createRecorderImpl: createRecorder,
  createInterruptController: createInterrupt,
  createRunSession: createInkSession,
  loadProjectImpl: loadProject,
  now: () => new Date().toISOString(),
  runWorkflowImpl: runWorkflow,
  writeStderr: (text) => {
    process.stderr.write(text)
  },
  writeStdout: (text) => {
    process.stdout.write(text)
  },
}

function requiresJsonPromptHint(schema: InputDefinition): boolean {
  return schema.type !== "string"
}

function promptInitialValue(schema: InputDefinition): string | undefined {
  if (schema.default === undefined) {
    return undefined
  }

  if (schema.type === "string" && typeof schema.default === "string") {
    return schema.default
  }

  return compactJson(schema.default)
}

export function buildQuestion(key: string, schema: InputDefinition): UserInputQuestion {
  const lines = [`Input: ${key}`, `Type: ${schema.type}`]
  if (schema.description !== undefined) {
    lines.push(`Description: ${schema.description}`)
  }
  if (requiresJsonPromptHint(schema)) {
    lines.push("Enter JSON for non-string values.")
  }

  return {
    allowEmpty: true,
    header: key,
    id: key,
    initialValue: promptInitialValue(schema),
    isOther: false,
    isSecret: false,
    options: null,
    preserveWhitespace: true,
    question: lines.join("\n"),
  }
}

function answersFromPromptResolution(resolution: UserInputResolution): Record<string, string> {
  const answers: Record<string, string> = {}

  for (const [key, value] of Object.entries(resolution.answers)) {
    const answer = value.answers[0]
    if (answer !== undefined) {
      answers[key] = answer
    }
  }

  return answers
}

async function promptForOmittedInvocationInputs(options: {
  invocationInputs: Record<string, unknown>
  interrupt: InterruptController
  now: () => string
  runSession: RunSession
  workflow: WorkflowDocument
}): Promise<Record<string, unknown>> {
  const omittedInputs = findOmitted(options.workflow, options.invocationInputs)
  if (omittedInputs.length === 0) {
    return options.invocationInputs
  }

  const requestId = `workflow-inputs-${Bun.randomUUIDv7()}`
  const resolution = await options.runSession.handle({
    interaction: {
      created_at: options.now(),
      interaction_id: requestId,
      kind: "user_input",
      node_path: null,
      request: {
        itemId: requestId,
        kind: "user_input",
        questions: omittedInputs.map(({ key, schema }) => buildQuestion(key, schema)),
        requestId,
        turnId: requestId,
      },
      user_id: null,
    },
    kind: "interaction",
    signal: options.interrupt.signal,
    snapshot: initRunState(`pre-run-${requestId}`, options.workflow.id, options.now()),
  })

  if (resolution.kind !== "user_input") {
    throw new Error(`expected user_input resolution, got ${resolution.kind}`)
  }

  return mergePrompted(options.invocationInputs, answersFromPromptResolution(resolution))
}

function resolveHeadlessInvocationInputs(options: {
  invocationInputs: Record<string, unknown>
  workflow: WorkflowDocument
}): InputResult {
  const missing = findOmitted(options.workflow, options.invocationInputs)
    .filter(({ schema }) => schema.default === undefined)
    .map(({ key }) => key)

  if (missing.length > 0) {
    return {
      kind: "missing_inputs",
      message: `Missing required workflow inputs: ${missing.join(", ")}.`,
    }
  }

  return {
    kind: "ready",
    inputs: {
      ...defaults(options.workflow.inputs ?? {}),
      ...options.invocationInputs,
    },
  }
}

async function resolveInvocationInputs(options: {
  headless: boolean
  inputs: Record<string, unknown>
  interrupt: InterruptController
  now: () => string
  runSession: RunSession
  workflow: WorkflowDocument
}): Promise<InputResult> {
  if (options.headless) {
    return resolveHeadlessInvocationInputs({
      invocationInputs: options.inputs,
      workflow: options.workflow,
    })
  }

  return {
    kind: "ready",
    inputs: await promptForOmittedInvocationInputs({
      interrupt: options.interrupt,
      invocationInputs: options.inputs,
      now: options.now,
      runSession: options.runSession,
      workflow: options.workflow,
    }),
  }
}

function nodeLabel(node: NodeRef): string {
  return node.user_id ?? node.node_path
}

function formatVerboseEvent(event: RunEvent): string | null {
  switch (event.kind) {
    case "run_started":
      return `run started: ${event.snapshot.workflow_id}`
    case "node_started":
      return `step started: ${nodeLabel(event.node)} (${event.node.node_kind})`
    case "node_completed":
      return `step completed: ${nodeLabel(event.node)} (${event.node.status})${suffixLoopReason(event.node.result)}`
    case "node_skipped":
      return `step skipped: ${nodeLabel(event.node)} (${event.reason})`
    case "node_retrying":
      return `node retrying: ${event.user_id ?? event.node_path} attempt ${event.next_attempt}/${event.max_attempts} in ${formatDurationText(event.delay_ms)}`
    case "barrier_reached":
      return `barrier reached: ${event.barrier.reason}`
    case "barrier_resolved":
      return `barrier resolved: ${event.action}`
    case "interaction_requested":
      return `interaction requested: ${event.interaction.kind}`
    case "interaction_resolved":
      return `interaction resolved: ${event.resolution.kind}`
    case "run_finished":
      return `run finished: ${event.snapshot.status}`
    case "provider_event":
    case "step_output":
      return null
  }
}

function suffixLoopReason(result: unknown): string {
  const reason = formatLoopReason(result)
  return reason.length > 0 ? ` · ${reason}` : ""
}

function createOutputWriter(options: OutputWriterOptions, io: OutputIo): OutputWriter {
  const writeStdoutLine = (line: string) => io.writeStdout(`${line}\n`)
  const writeStderrLine = (line: string) => io.writeStderr(`${line}\n`)
  let snapshot: RunSnapshot | null = null

  const capture = (event: RunEvent) => {
    if (event.kind === "run_finished") {
      snapshot = event.snapshot
    }
  }

  switch (options.mode.kind) {
    case "headless_stream_json":
      return {
        emit: (event) => {
          capture(event)
          writeStdoutLine(compactJson(event))
        },
        finalSnapshot: () => snapshot,
        finish: (_snapshot, summary) => writeStdoutLine(compactJson({ kind: "summary", summary })),
        replayFinalError: () => true,
        replayFinalResult: () => true,
      }
    case "headless_json":
      return {
        emit: capture,
        finalSnapshot: () => snapshot,
        finish: (_snapshot, summary) => writeStdoutLine(compactJson(summary)),
        replayFinalError: () => true,
        replayFinalResult: () => true,
      }
    case "interactive":
    case "headless_text":
      if (options.mode.kind === "headless_text" && options.mode.verbose) {
        break
      }
      return {
        emit: capture,
        finalSnapshot: () => snapshot,
        finish: () => {},
        replayFinalError: () => true,
        replayFinalResult: () => true,
      }
  }

  let replayError = true
  let replayResult = true
  const emitted = new Set<string>()

  return {
    emit: (event) => {
      capture(event)
      if (event.kind === "step_output") {
        emitted.add(outputKey(event.node_path, event.attempt, event.stream))
        if (event.stream === "stdout") {
          io.writeStdout(event.chunk)
          return
        }
        io.writeStderr(event.chunk)
        return
      }

      const marker = formatVerboseEvent(event)
      if (marker !== null) {
        writeStderrLine(marker)
      }
    },
    finalSnapshot: () => snapshot,
    finish: (snapshot, summary) => {
      replayError = shouldReplayError(snapshot, summary, emitted)
      replayResult = shouldReplayResult(snapshot, emitted)
    },
    replayFinalError: () => replayError,
    replayFinalResult: () => replayResult,
  }
}

function createSession(
  options: SessionOptions,
  deps: SessionDeps,
  interrupt: InterruptController,
  project: WorkflowProject,
  workflow: WorkflowDocument,
): RunSession {
  if (options.mode.kind !== "interactive") {
    return deps.createHeadlessSession()
  }

  return deps.createRunSession({
    barrierMode: options.autoContinue ? "auto_continue" : "manual",
    interrupt: interrupt.interrupt,
    project,
    workflow,
  })
}

function isRootNode(nodePath: string): boolean {
  return nodePath.split("/").filter(Boolean).length === 1
}

function resolveTopNode(snapshot: RunSnapshot): NodeSnapshot | undefined {
  return snapshot.nodes.findLast((node) => isRootNode(node.node_path) && node.status === "succeeded")
}

function resolveFailureNode(snapshot: RunSnapshot): NodeSnapshot | undefined {
  return snapshot.nodes.findLast(
    (node) =>
      (node.status === "failed" || node.status === "interrupted") &&
      typeof node.stderr === "string" &&
      node.stderr.trim().length > 0,
  )
}

function resolveTextFailureMessage(snapshot: RunSnapshot): string {
  const failedNode = resolveFailureNode(snapshot)
  if (typeof failedNode?.stderr === "string") {
    return failedNode.stderr.trim()
  }

  if (snapshot.reason !== null && snapshot.reason !== undefined) {
    return RUN_REASON_MESSAGES[snapshot.reason]
  }

  return "Workflow failed."
}

function shouldReplayError(snapshot: RunSnapshot, summary: WorkflowResultSummary, emitted: Set<string>): boolean {
  if (summary.error === null) {
    return false
  }

  const node = resolveFailureNode(snapshot)
  if (node === undefined) {
    return true
  }

  if (typeof node.stderr !== "string") {
    return true
  }

  if (!emitted.has(outputKey(node.node_path, node.attempt, "stderr"))) {
    return true
  }

  return node.stderr.trim() !== summary.error
}

function shouldReplayResult(snapshot: RunSnapshot, emitted: Set<string>): boolean {
  const node = resolveTopNode(snapshot)
  if (node === undefined) {
    return true
  }

  if (node.result === null || node.result === undefined) {
    return false
  }

  if (!emitted.has(outputKey(node.node_path, node.attempt, "stdout"))) {
    return true
  }

  if (typeof node.stdout !== "string") {
    return true
  }

  const result = stringifyOptional(node.result)
  if (result !== null && node.stdout === result) {
    return false
  }

  if (typeof node.result === "string") {
    return true
  }

  const parsed = safeParseJson(node.stdout)
  if (parsed.kind === "ok" && deepEqual(parsed.value, node.result)) {
    return false
  }

  return true
}

function outputKey(nodePath: string, attempt: number | undefined, stream: "stderr" | "stdout"): string {
  return `${nodePath}#${attempt ?? 1}:${stream}`
}

function durationMs(startedAt: string, finishedAt: string | null | undefined): number | null {
  if (finishedAt === null || finishedAt === undefined) {
    return null
  }

  return elapsedMs(startedAt, finishedAt)
}

export function resolveWorkflowResult(snapshot: RunSnapshot): WorkflowResultSummary {
  const resultNode = snapshot.status === "succeeded" ? resolveTopNode(snapshot) : undefined

  return {
    durationMs: durationMs(snapshot.started_at, snapshot.finished_at),
    error: snapshot.status === "succeeded" ? null : resolveTextFailureMessage(snapshot),
    finishedAt: snapshot.finished_at ?? null,
    phase: snapshot.phase,
    reason: snapshot.reason ?? null,
    result: snapshot.status === "succeeded" ? (resultNode?.result ?? null) : null,
    runId: snapshot.run_id,
    startedAt: snapshot.started_at,
    status: snapshot.status,
    steps: snapshot.nodes.map((node) => ({
      attempt: node.attempt,
      durationMs: node.duration_ms ?? null,
      exitCode: node.exit_code ?? null,
      finishedAt: node.finished_at ?? null,
      id: node.user_id ?? null,
      kind: node.node_kind,
      path: node.node_path,
      result: node.result ?? null,
      startedAt: node.started_at ?? null,
      status: node.status,
      waitingFor: node.waiting_for ?? null,
    })),
    workflowId: snapshot.workflow_id,
  }
}

export async function runCommand(
  cwd: string,
  workflowId: string | undefined,
  options: RunCommandOptions,
  dependencies: Partial<Dependencies> = {},
): Promise<CommandResult> {
  const errorResult = (errors: string[], warnings: string[] = []) =>
    renderErrorResult({ errors, mode: options.mode, warnings })

  if (workflowId === undefined) {
    return errorResult(["Usage: rigg run <workflow_id>"])
  }

  const deps = { ...defaultDependencies, ...dependencies }
  const outputWriter = createOutputWriter(options, deps)
  let warnings: string[] = []

  try {
    const projectResult = await deps.loadProjectImpl(cwd)
    if (projectResult.kind === "not_found") {
      return errorResult([PROJECT_NOT_FOUND_MESSAGE])
    }
    if (projectResult.kind === "invalid") {
      return errorResult(renderErrors(projectResult.errors))
    }

    const inputs = parseEntries(options.inputs)
    if (inputs.kind === "invalid") {
      return errorResult([inputs.message])
    }

    const workflow = workflowById(projectResult.project, workflowId)
    if (workflow === undefined) {
      return errorResult([`Workflow "${workflowId}" not found.`])
    }

    if (options.mode.kind === "interactive" && (!process.stdin.isTTY || !process.stderr.isTTY)) {
      return errorResult([
        "`rigg run` requires a TTY because step barriers and workflow input prompts are interactive. Re-run in an interactive terminal. `--auto-continue` only works in an interactive terminal.",
      ])
    }

    const interrupt = deps.createInterruptController()
    const runSession = createSession(options, deps, interrupt, projectResult.project, workflow)
    const recorder = await deps.createRecorderImpl({
      workflowId: workflow.id,
      workspace: projectResult.project.workspace,
    })
    let recorderResult: Awaited<ReturnType<typeof recorder.close>> = { recording_status: "disabled", warnings: [] }

    const runResult = await (async () => {
      try {
        const inputResult = await resolveInvocationInputs({
          headless: options.mode.kind !== "interactive",
          inputs: inputs.inputs,
          interrupt,
          now: deps.now,
          runSession,
          workflow,
        })

        if (inputResult.kind !== "ready") {
          return inputResult
        }

        return await deps.runWorkflowImpl({
          controlHandler: runSession.handle,
          invocationInputs: inputResult.inputs,
          onEvent: (event) => {
            runSession.emit(event)
            outputWriter.emit(event)
            recorder.emit(snapEvent(event))
          },
          parentEnv: process.env,
          project: projectResult.project,
          signal: interrupt.signal,
          workflowId,
        })
      } finally {
        recorderResult = await recorder.close()
        warnings = recorderResult.warnings
        interrupt.dispose()
        runSession.close()
      }
    })()

    if (runResult.kind === "missing_inputs" || runResult.kind === "workflow_not_found") {
      return errorResult([runResult.message], recorderResult.warnings)
    }
    if (runResult.kind === "invalid_input") {
      return errorResult(runResult.errors, recorderResult.warnings)
    }

    const summary = resolveWorkflowResult(runResult.snapshot)
    outputWriter.finish(runResult.snapshot, summary)

    return renderRunResult({
      mode: options.mode,
      replayFinalError: outputWriter.replayFinalError(),
      replayFinalResult: outputWriter.replayFinalResult(),
      warnings: recorderResult.warnings,
      summary,
    })
  } catch (error) {
    const snapshot = outputWriter.finalSnapshot()
    if (snapshot !== null) {
      const summary = resolveWorkflowResult(snapshot)
      outputWriter.finish(snapshot, summary)
      return renderRunResult({
        mode: options.mode,
        replayFinalError: outputWriter.replayFinalError(),
        replayFinalResult: outputWriter.replayFinalResult(),
        summary,
        warnings,
      })
    }

    return errorResult([normalizeError(error).message], warnings)
  }
}

function renderErrorResult(options: { errors: string[]; mode: RunMode; warnings: string[] }): CommandResult {
  const lines = [...options.warnings, ...options.errors]
  switch (options.mode.kind) {
    case "interactive":
    case "headless_text":
      return failure(lines)
    case "headless_json":
      return failure([], 1, [compactJson({ errors: options.errors, status: "failed", warnings: options.warnings })])
    case "headless_stream_json": {
      const stdoutLines = options.warnings.map((message) => compactJson({ kind: "warning", message }))
      stdoutLines.push(compactJson({ errors: options.errors, kind: "error" }))
      return failure([], 1, stdoutLines)
    }
  }
}

function renderRunResult(options: {
  mode: RunMode
  replayFinalError: boolean
  replayFinalResult: boolean
  summary: WorkflowResultSummary
  warnings: string[]
}): CommandResult {
  const stderrLines = [...options.warnings]
  if (options.mode.kind !== "headless_text") {
    return options.summary.status === "succeeded" ? success([], stderrLines) : failure(stderrLines, 1)
  }

  if (options.replayFinalError && options.summary.error !== null) {
    stderrLines.push(options.summary.error)
  }

  if (!options.replayFinalResult) {
    return options.summary.status === "succeeded" ? success([], stderrLines) : failure(stderrLines, 1)
  }

  const result = stringifyOptional(options.summary.result)
  const stdoutLines =
    result === null || result.length === 0 ? [] : result.endsWith("\n") ? [result.slice(0, -1)] : [result]

  return options.summary.status === "succeeded"
    ? success(stdoutLines, stderrLines)
    : failure(stderrLines, 1, stdoutLines)
}
