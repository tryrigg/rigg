import { listWorkflowIds, type WorkflowProject } from "../project"
import type { CompileDiagnostic } from "../workflow/diag"

export function formatLoopReason(result: unknown): string {
  if (typeof result !== "object" || result === null || !("reason" in result)) {
    return ""
  }
  if (result.reason === "until_satisfied") {
    return "until satisfied"
  }
  if (result.reason === "max_reached") {
    return "max reached"
  }
  return ""
}

export function renderErrors(errors: CompileDiagnostic[]): string[] {
  return errors.flatMap((error) => renderError(error))
}

export function renderSummary(project: WorkflowProject): string[] {
  const ids = listWorkflowIds(project)

  return [
    `Discovered ${project.files.length} workflow file(s) in ${project.workspace.riggDir}.`,
    ...ids.map((id) => `- ${id}`),
  ]
}

export function writeLines(lines: string[], stream: NodeJS.WriteStream): void {
  if (lines.length === 0) {
    return
  }

  stream.write(`${lines.join("\n")}\n`)
}

function renderError(error: CompileDiagnostic): string[] {
  if (
    error.filePath === undefined ||
    error.line === undefined ||
    error.column === undefined ||
    error.snippet === undefined
  ) {
    const location = error.filePath === undefined ? "" : ` [${error.filePath}]`
    return [`${error.code}${location}: ${error.message}`]
  }

  const gutter = String(error.line)
  const caret = `${" ".repeat(Math.max(error.column - 1, 0))}^`

  return [
    `${error.code}: ${error.message}`,
    `  --> ${error.filePath}:${error.line}:${error.column}`,
    "   |",
    `${gutter} | ${error.snippet}`,
    `   | ${caret}`,
    ...(error.hints ?? []).map((hint) => `   = hint: ${hint}`),
  ]
}
