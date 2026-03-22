import { normalizeError } from "../util/error"
import { decode } from "../workflow/decode"
import { isDiag, type CompileDiagnostic } from "../workflow/diag"
import { parseYaml } from "../workflow/parse"
import { checkWorkspace } from "../workflow/check"
import { discover } from "./find"
import { readWorkspace } from "./read"
import type { WorkflowDocument } from "../workflow/schema"
import type { DecodedWorkflowFile, WorkflowProject } from "./model"

export type LoadProjectResult =
  | { kind: "ok"; project: WorkflowProject }
  | { kind: "not_found" }
  | { kind: "invalid"; errors: CompileDiagnostic[] }

export async function loadProject(startDir: string): Promise<LoadProjectResult> {
  const workspaceResult = await discover(startDir)
  if (workspaceResult.kind === "not_found") {
    return { kind: "not_found" }
  }

  let sourceFiles
  try {
    sourceFiles = await readWorkspace(workspaceResult.workspace)
  } catch (error) {
    const cause = normalizeError(error)
    return {
      kind: "invalid",
      errors: [isDiag(cause) ? cause : { code: "read_failed", message: cause.message, cause }],
    }
  }

  const files: DecodedWorkflowFile[] = []
  const errors: CompileDiagnostic[] = []

  for (const sourceFile of sourceFiles) {
    const parsedResult = parseYaml(sourceFile.text, sourceFile.filePath)
    if (parsedResult.kind === "invalid_yaml") {
      errors.push(parsedResult.error)
      continue
    }

    const decodedResult = decode(parsedResult.document, sourceFile.filePath)
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

  const validationErrors = checkWorkspace(project)
  return validationErrors.length > 0 ? { kind: "invalid", errors: validationErrors } : { kind: "ok", project }
}

export function listWorkflowIds(project: WorkflowProject): string[] {
  return project.files.map((file) => file.workflow.id).sort()
}

export function workflowById(project: WorkflowProject, workflowId: string): WorkflowDocument | undefined {
  return project.files.find((file) => file.workflow.id === workflowId)?.workflow
}
