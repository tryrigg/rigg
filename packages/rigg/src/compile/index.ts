import { decodeWorkflowFile } from "./decode"
import { isCompileDiagnostic, type CompileDiagnostic } from "./diagnostic"
import { discoverWorkspace, type DecodedWorkflowFile, type WorkflowProject } from "./project"
import { readWorkspace } from "./source"
import { parseYamlDocument } from "./syntax"
import { validateWorkspace } from "./validate"
import { normalizeError } from "../util/error"

export type { CompileDiagnostic } from "./diagnostic"
export type { WorkflowProject } from "./project"

export type LoadWorkflowProjectResult =
  | { kind: "success"; project: WorkflowProject }
  | { kind: "invalid"; errors: CompileDiagnostic[] }

export async function loadWorkflowProject(startDir: string): Promise<LoadWorkflowProjectResult> {
  const workspaceResult = await discoverWorkspace(startDir)
  if (workspaceResult.kind === "not_found") {
    return { kind: "invalid", errors: [workspaceResult.error] }
  }

  let sourceFiles
  try {
    sourceFiles = await readWorkspace(workspaceResult.workspace)
  } catch (error) {
    const cause = normalizeError(error)
    return {
      kind: "invalid",
      errors: [isCompileDiagnostic(cause) ? cause : { code: "read_failed", message: cause.message, cause }],
    }
  }

  const files: DecodedWorkflowFile[] = []
  const errors: CompileDiagnostic[] = []

  for (const sourceFile of sourceFiles) {
    const parsedResult = parseYamlDocument(sourceFile.text, sourceFile.filePath)
    if (parsedResult.kind === "invalid_yaml") {
      errors.push(parsedResult.error)
      continue
    }

    const decodedResult = decodeWorkflowFile(parsedResult.document, sourceFile.filePath)
    if (decodedResult.kind === "invalid_workflow") {
      errors.push(decodedResult.error)
      continue
    }

    files.push({
      filePath: sourceFile.filePath,
      relativePath: sourceFile.relativePath,
      workflow: decodedResult.workflow,
    })
  }

  if (errors.length > 0) {
    return { kind: "invalid", errors }
  }

  const project: WorkflowProject = {
    workspace: workspaceResult.workspace,
    files,
  }

  const validationErrors = validateWorkspace(project)
  return validationErrors.length > 0 ? { kind: "invalid", errors: validationErrors } : { kind: "success", project }
}

export function listWorkflowIds(project: WorkflowProject): string[] {
  return project.files.map((file) => file.workflow.id).sort()
}
