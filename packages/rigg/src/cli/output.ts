import { listWorkflowIds, type WorkflowProject } from "../compile/index"
import type { CompileError } from "../compile/index"

export function renderCompileErrors(errors: CompileError[]): string[] {
  return errors.map((error) => {
    const location = error.filePath === undefined ? "" : ` [${error.filePath}]`
    return `${error.code}${location}: ${error.message}`
  })
}

export function renderWorkflowSummary(project: WorkflowProject): string[] {
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
