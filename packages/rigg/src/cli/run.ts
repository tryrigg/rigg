import { randomUUID } from "node:crypto"

import type { UserInputQuestion, UserInputResolution } from "../session/interaction"
import { loadProject, workflowById } from "../project"
import { runWorkflow } from "../session"
import { interrupt } from "../session/error"
import { findOmitted, mergePrompted, parseEntries } from "../session/input"
import { initRunState } from "../session/state"
import type { InputDefinition } from "../workflow/input"
import type { WorkflowDocument } from "../workflow/schema"
import { normalizeError } from "../util/error"
import { compactJson } from "../util/json"
import { renderErrors } from "./out"
import { createInkSession } from "./session"

type CommandResult = {
  exitCode: number
  stderrLines: string[]
  stdoutLines: string[]
}

function success(stdoutLines: string[] = [], stderrLines: string[] = []): CommandResult {
  return { exitCode: 0, stderrLines, stdoutLines }
}

function failure(stderrLines: string[] = [], exitCode = 1, stdoutLines: string[] = []): CommandResult {
  return { exitCode, stderrLines, stdoutLines }
}

function toTitleCase(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1)
}

function toPascalCase(value: string): string {
  return value
    .split("_")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join("")
}

export type InterruptController = {
  dispose: () => void
  interrupt: () => void
  signal: AbortSignal
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
  createInterruptController: () => InterruptController
  createRunSession: typeof createInkSession
  loadProjectImpl: typeof loadProject
  now: () => string
  runWorkflowImpl: typeof runWorkflow
}

const defaultDependencies: Dependencies = {
  createInterruptController: createInterrupt,
  createRunSession: createInkSession,
  loadProjectImpl: loadProject,
  now: () => new Date().toISOString(),
  runWorkflowImpl: runWorkflow,
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
  runSession: ReturnType<typeof createInkSession>
  workflow: WorkflowDocument
}): Promise<Record<string, unknown>> {
  const omittedInputs = findOmitted(options.workflow, options.invocationInputs)
  if (omittedInputs.length === 0) {
    return options.invocationInputs
  }

  const requestId = `workflow-inputs-${randomUUID()}`
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

const PROJECT_NOT_FOUND_MESSAGE = "Could not find a .rigg directory from the current working directory."

export async function runCommand(
  cwd: string,
  workflowId: string | undefined,
  options: { autoContinue: boolean; inputs: string[] },
  dependencies: Partial<Dependencies> = {},
): Promise<CommandResult> {
  if (workflowId === undefined) {
    return failure(["Usage: rigg run <workflow_id>"])
  }

  try {
    const deps = { ...defaultDependencies, ...dependencies }
    const projectResult = await deps.loadProjectImpl(cwd)
    if (projectResult.kind === "not_found") {
      return failure([PROJECT_NOT_FOUND_MESSAGE])
    }
    if (projectResult.kind === "invalid") {
      return failure(renderErrors(projectResult.errors))
    }

    const inputs = parseEntries(options.inputs)
    if (inputs.kind === "invalid") {
      return failure([inputs.message])
    }

    const workflow = workflowById(projectResult.project, workflowId)
    if (workflow === undefined) {
      return failure([`Workflow "${workflowId}" not found.`])
    }

    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      return failure([
        "`rigg run` requires a TTY because step barriers and workflow input prompts are interactive. Re-run in an interactive terminal. `--auto-continue` only works in an interactive terminal.",
      ])
    }

    const interrupt = deps.createInterruptController()
    const runSession = deps.createRunSession({
      barrierMode: options.autoContinue ? "auto_continue" : "manual",
      interrupt: interrupt.interrupt,
      project: projectResult.project,
      workflow,
    })

    const runResult = await (async () => {
      try {
        const invocationInputs = await promptForOmittedInvocationInputs({
          interrupt,
          invocationInputs: inputs.inputs,
          now: deps.now,
          runSession,
          workflow,
        })

        return await deps.runWorkflowImpl({
          controlHandler: runSession.handle,
          invocationInputs,
          onEvent: runSession.emit,
          parentEnv: process.env,
          project: projectResult.project,
          signal: interrupt.signal,
          workflowId,
        })
      } finally {
        interrupt.dispose()
        runSession.close()
      }
    })()

    if (runResult.kind === "workflow_not_found") {
      return failure([runResult.message])
    }
    if (runResult.kind === "invalid_input") {
      return failure(runResult.errors)
    }

    const stdoutLines = [
      `${runResult.snapshot.workflow_id} finished with status ${toTitleCase(runResult.snapshot.status)}.`,
    ]
    if (runResult.snapshot.reason !== null && runResult.snapshot.reason !== undefined) {
      stdoutLines.push(`Reason: ${toPascalCase(runResult.snapshot.reason)}`)
    }

    return runResult.snapshot.status === "succeeded" ? success(stdoutLines) : failure([], 1, stdoutLines)
  } catch (error) {
    return failure([normalizeError(error).message])
  }
}
