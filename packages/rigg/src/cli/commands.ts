import { appendFile, mkdir } from "node:fs/promises"
import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { join } from "node:path"

import { listWorkflowIds, loadWorkflowProject } from "../compile/index"
import { stringifyJson } from "../util/json"
import { normalizeError } from "../util/error"
import { runWorkflow } from "../run/index"
import { discoverProjectRoot, readLogs, readStatuses } from "../history/index"
import { examplesDoc, schemaReferenceDoc, skillDoc, workflowSyntaxDoc } from "./docs"
import { planTemplate, reviewBranchTemplate, reviewCommitTemplate, reviewUncommittedTemplate } from "./templates"
import { RIGG_VERSION } from "../version"
import { TerminalProgressSink } from "./progress"
import { renderCompileErrors } from "./output"

const runsIgnoreEntry = "/.rigg/runs/"

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
  const gitignorePath = join(cwd, ".gitignore")

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

  await Promise.all([
    mkdir(join(cwd, ".agents/skills/rigg"), { recursive: true }),
    mkdir(join(cwd, ".claude/skills/rigg"), { recursive: true }),
  ])
  await Promise.all([
    writeIfMissing(join(cwd, ".agents/skills/rigg/SKILL.md"), skillDoc),
    writeIfMissing(join(cwd, ".claude/skills/rigg/SKILL.md"), skillDoc),
  ])

  if (!(await exists(gitignorePath))) {
    await Bun.write(gitignorePath, `${runsIgnoreEntry}\n`)
  } else {
    const gitignoreText = await Bun.file(gitignorePath).text()
    if (!gitignoreText.includes(runsIgnoreEntry)) {
      const needsNewline = gitignoreText.length > 0 && !gitignoreText.endsWith("\n")
      await appendFile(gitignorePath, `${needsNewline ? "\n" : ""}${runsIgnoreEntry}\n`, "utf8")
    }
  }

  return [
    "Initialized .rigg/ with example workflows.",
    "Generated workflows: plan, review-uncommitted, review-branch, review-commit.",
    "Generated .rigg/docs/ with workflow authoring documentation.",
    "Generated .agents/skills/rigg/ and .claude/skills/rigg/ for AI-assisted workflow authoring.",
    "Examples:",
    "  rigg run plan --input requirements='...' --input output_path=plan.md",
    "  rigg run review-uncommitted",
    "  rigg run review-branch --input base_branch=main",
    "  rigg run review-commit --input commit_sha=HEAD~1",
  ]
}

type ParseInputsResult = { kind: "valid"; inputs: Record<string, unknown> } | { kind: "invalid"; message: string }

function parseInputs(values: string[]): ParseInputsResult {
  const output: Record<string, unknown> = {}

  for (const value of values) {
    const [key, ...rest] = value.split("=")
    if (key === undefined || key.length === 0 || rest.length === 0) {
      return { kind: "invalid", message: `invalid --input \`${value}\`; expected KEY=VALUE` }
    }

    const rawValue = rest.join("=")
    try {
      output[key] = JSON.parse(rawValue)
    } catch {
      output[key] = rawValue
    }
  }

  return { kind: "valid", inputs: output }
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
  options: {
    inputs: string[]
    json: boolean
    quiet: boolean
  },
): Promise<CommandResult> {
  if (workflowId === undefined) {
    return failure(["Usage: rigg run <workflow_id>"])
  }

  try {
    const projectResult = await loadWorkflowProject(cwd)
    if (projectResult.kind === "invalid") {
      return failure(renderCompileErrors(projectResult.errors))
    }

    const inputs = parseInputs(options.inputs)
    if (inputs.kind === "invalid") {
      return failure([inputs.message])
    }

    const progressSink =
      options.quiet || options.json || !process.stderr.isTTY ? undefined : new TerminalProgressSink(process.stderr)
    const runResult = await runWorkflow({
      configFiles: projectResult.project.files.map((file) => file.filePath),
      cwd,
      invocationInputs: inputs.inputs,
      onProgress: progressSink?.emit.bind(progressSink),
      parentEnv: process.env,
      project: projectResult.project,
      toolVersion: RIGG_VERSION,
      workflowId,
    })

    if (runResult.kind === "workflow_not_found") {
      return failure([runResult.message])
    }
    if (runResult.kind === "invalid_input") {
      return failure(runResult.errors)
    }

    if (options.json) {
      const payload = stringifyJson(runResult.snapshot)
      return runResult.snapshot.status === "succeeded" ? success([payload]) : failure([], 1, [payload])
    }

    const stdoutLines = [
      `Run ${runResult.snapshot.run_id} finished with status ${toTitleCase(runResult.snapshot.status)}.`,
    ]
    if (runResult.snapshot.reason !== null && runResult.snapshot.reason !== undefined) {
      stdoutLines.push(`Reason: ${toPascalCase(runResult.snapshot.reason)}`)
    }

    return runResult.snapshot.status === "succeeded" ? success(stdoutLines) : failure([], 1, stdoutLines)
  } catch (error) {
    return failure([normalizeError(error).message])
  }
}

export async function runStatusCommand(cwd: string, runId?: string, json = false): Promise<CommandResult> {
  const root = await discoverProjectRoot(cwd)
  if (root.kind === "not_found") {
    return failure([root.message])
  }

  try {
    const statuses = await readStatuses(root.rootDir, runId)
    if (json) {
      return success([stringifyJson(statuses)])
    }

    if (statuses.length === 0) {
      return success(["No runs found."])
    }

    const lines: string[] = []
    for (const snapshot of statuses) {
      lines.push(`${snapshot.run_id}  ${snapshot.workflow_id}  ${toTitleCase(snapshot.status)}`)
      for (const node of snapshot.nodes) {
        const label = node.user_id ?? node.node_path
        lines.push(`  ${label.padEnd(16, " ")} ${toTitleCase(node.status)} exit=${String(node.exit_code)}`)
      }
    }

    return success(lines)
  } catch (error) {
    return failure([normalizeError(error).message])
  }
}

export async function runLogsCommand(
  cwd: string,
  runId: string | undefined,
  options: {
    node?: string
    stderr: boolean
  },
): Promise<CommandResult> {
  if (runId === undefined) {
    return failure(["Usage: rigg logs <run_id> [--node id] [--stderr]"])
  }

  const root = await discoverProjectRoot(cwd)
  if (root.kind === "not_found") {
    return failure([root.message])
  }

  try {
    const output = await readLogs(root.rootDir, runId, {
      ...(options.node === undefined ? {} : { node: options.node }),
      stream: options.stderr ? "stderr" : "stdout",
    })
    if (output.kind === "not_found") {
      return failure([output.message])
    }

    return success(output.output.split(/\r?\n/))
  } catch (error) {
    return failure([normalizeError(error).message])
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
