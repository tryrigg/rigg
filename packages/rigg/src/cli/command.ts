import { mkdir } from "node:fs/promises"
import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"

import type { CodexUserInputQuestion, CodexUserInputResolution } from "../codex/interaction"
import { listWorkflowIds, loadWorkflowProject } from "../compile/index"
import type { InputDefinition, WorkflowDocument } from "../compile/schema"
import { stringifyJson, stringifyJsonCompact } from "../util/json"
import { isMissingPathError, normalizeError } from "../util/error"
import { runWorkflow } from "../run/index"
import {
  findOmittedInvocationInputs,
  mergePromptedInvocationInputs,
  parseInvocationInputEntries,
} from "../run/invocation"
import { examplesDoc, schemaReferenceDoc, skillDoc, workflowSyntaxDoc } from "./docs"
import { planTemplate, reviewBranchTemplate, reviewCommitTemplate, reviewUncommittedTemplate } from "./templates"
import { renderCompileErrors } from "./output"
import { createInkRunSession } from "./run"
import { workflowById } from "../compile/project"
import { StepInterruptedError } from "../run/error"
import { createInitialRunState } from "../run/state"

type CommandResult = {
  exitCode: number
  stderrLines: string[]
  stdoutLines: string[]
}

function success(stdoutLines: string[] = [], stderrLines: string[] = []): CommandResult {
  return {
    exitCode: 0,
    stderrLines,
    stdoutLines,
  }
}

function failure(stderrLines: string[] = [], exitCode = 1, stdoutLines: string[] = []): CommandResult {
  return {
    exitCode,
    stderrLines,
    stdoutLines,
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch (error) {
    if (isMissingPathError(error)) {
      return false
    }
    throw error
  }
}

async function writeIfMissing(path: string, contents: string): Promise<void> {
  if (await exists(path)) {
    return
  }

  await Bun.write(path, contents)
}

async function writeInitialWorkspace(cwd: string): Promise<string[]> {
  const riggDir = join(cwd, ".rigg")
  const docsDir = join(riggDir, "docs")
  await mkdir(docsDir, { recursive: true })

  await Promise.all([
    writeIfMissing(join(riggDir, "plan.yaml"), planTemplate),
    writeIfMissing(join(riggDir, "review-uncommitted.yaml"), reviewUncommittedTemplate),
    writeIfMissing(join(riggDir, "review-branch.yaml"), reviewBranchTemplate),
    writeIfMissing(join(riggDir, "review-commit.yaml"), reviewCommitTemplate),
    writeIfMissing(join(docsDir, "workflow-syntax.md"), workflowSyntaxDoc),
    writeIfMissing(join(docsDir, "schema-reference.md"), schemaReferenceDoc),
    writeIfMissing(join(docsDir, "examples.md"), examplesDoc),
  ])

  await Promise.all([mkdir(join(cwd, ".agents/skills/rigg"), { recursive: true })])
  await writeIfMissing(join(cwd, ".agents/skills/rigg/SKILL.md"), skillDoc)

  return [
    "Initialized .rigg/ with example workflows.",
    "Generated workflows: plan, review-uncommitted, review-branch, review-commit.",
    "Generated .rigg/docs/ with workflow authoring documentation.",
    "Generated .agents/skills/rigg/ for AI-assisted workflow authoring.",
    "Examples:",
    "  rigg run plan --input requirements='...' --input output_path=plan.md",
    "  rigg run review-uncommitted",
    "  rigg run review-branch --input base_branch=main",
    "  rigg run review-commit --input commit_sha=HEAD~1",
  ]
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

export type WorkflowInterruptController = {
  dispose: () => void
  interrupt: () => void
  signal: AbortSignal
}

export function createWorkflowInterruptController(): WorkflowInterruptController {
  const controller = new AbortController()

  const interrupt = () => {
    if (!controller.signal.aborted) {
      controller.abort(new StepInterruptedError("workflow interrupted by operator"))
      return
    }

    process.off("SIGINT", interrupt)
    process.kill(process.pid, "SIGINT")
  }

  process.on("SIGINT", interrupt)
  return {
    dispose: () => process.off("SIGINT", interrupt),
    interrupt,
    signal: controller.signal,
  }
}

export type RunCommandDependencies = {
  createInterruptController: () => WorkflowInterruptController
  createRunSession: typeof createInkRunSession
  loadProject: typeof loadWorkflowProject
  now: () => string
  runWorkflowImpl: typeof runWorkflow
}

const defaultRunCommandDependencies: RunCommandDependencies = {
  createInterruptController: createWorkflowInterruptController,
  createRunSession: createInkRunSession,
  loadProject: loadWorkflowProject,
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

  return stringifyJsonCompact(schema.default)
}

export function buildOmittedInputQuestion(key: string, schema: InputDefinition): CodexUserInputQuestion {
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

function answersFromPromptResolution(resolution: CodexUserInputResolution): Record<string, string> {
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
  interrupt: WorkflowInterruptController
  now: () => string
  runSession: ReturnType<typeof createInkRunSession>
  workflow: WorkflowDocument
}): Promise<Record<string, unknown>> {
  const omittedInputs = findOmittedInvocationInputs(options.workflow, options.invocationInputs)
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
        questions: omittedInputs.map(({ key, schema }) => buildOmittedInputQuestion(key, schema)),
        requestId,
        turnId: requestId,
      },
      user_id: null,
    },
    kind: "interaction",
    signal: options.interrupt.signal,
    snapshot: createInitialRunState(`pre-run-${requestId}`, options.workflow.id, options.now()),
  })

  if (resolution.kind !== "user_input") {
    throw new Error(`expected user_input resolution, got ${resolution.kind}`)
  }

  return mergePromptedInvocationInputs(options.invocationInputs, answersFromPromptResolution(resolution))
}

export async function runInitCommand(cwd: string): Promise<CommandResult> {
  try {
    return success(await writeInitialWorkspace(cwd))
  } catch (error) {
    return failure([normalizeError(error).message])
  }
}

export async function runValidateCommand(cwd: string, json = false): Promise<CommandResult> {
  try {
    const result = await loadWorkflowProject(cwd)
    if (result.kind === "invalid") {
      return failure(renderCompileErrors(result.errors))
    }

    const workflowIds = listWorkflowIds(result.project)
    if (json) {
      return success([
        stringifyJson({
          config_files: result.project.files.map((file) => file.filePath),
          ok: true,
          project_root: result.project.workspace.rootDir,
          workflows: workflowIds,
        }),
      ])
    }

    return success([`Validated ${workflowIds.length} workflow(s): ${workflowIds.join(", ")}`])
  } catch (error) {
    return failure([normalizeError(error).message])
  }
}

export async function runRunCommand(
  cwd: string,
  workflowId: string | undefined,
  options: { autoContinue: boolean; inputs: string[] },
  dependencies: Partial<RunCommandDependencies> = {},
): Promise<CommandResult> {
  if (workflowId === undefined) {
    return failure(["Usage: rigg run <workflow_id>"])
  }

  try {
    const deps = { ...defaultRunCommandDependencies, ...dependencies }
    const projectResult = await deps.loadProject(cwd)
    if (projectResult.kind === "invalid") {
      return failure(renderCompileErrors(projectResult.errors))
    }

    const inputs = parseInvocationInputEntries(options.inputs)
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
