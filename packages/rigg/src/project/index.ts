import { lstat, readdir } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"

import { normalizeError, isMissingPathError } from "../util/error"
import { checkWorkspace } from "../workflow/check"
import { decode } from "../workflow/decode"
import { createDiag, CompileDiagnosticCode, isDiag, type CompileDiagnostic } from "../workflow/diag"
import { parseYaml } from "../workflow/parse"
import type { WorkflowDocument } from "../workflow/schema"

export type WorkspacePaths = {
  rootDir: string
  riggDir: string
}

type WorkflowSourceFile = {
  filePath: string
  relativePath: string
  text: string
}

type DecodedWorkflowFile = {
  filePath: string
  relativePath: string
  workflow: WorkflowDocument
}

export type WorkflowProject = {
  workspace: WorkspacePaths
  files: DecodedWorkflowFile[]
}

export type LoadProjectResult =
  | { kind: "ok"; project: WorkflowProject }
  | { kind: "not_found" }
  | { kind: "invalid"; errors: CompileDiagnostic[] }

type WorkspaceDiscoveryResult =
  | { kind: "found"; workspace: WorkspacePaths }
  | { kind: "not_found"; error: CompileDiagnostic }

const workflowFileExtensions = new Set([".yaml", ".yml"])

async function discover(startDir: string): Promise<WorkspaceDiscoveryResult> {
  let currentDir = resolve(startDir)

  while (true) {
    const riggDir = join(currentDir, ".rigg")

    try {
      const stat = await lstat(riggDir)
      if (stat.isDirectory()) {
        return {
          kind: "found",
          workspace: {
            rootDir: currentDir,
            riggDir,
          },
        }
      }
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error
      }
    }

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) {
      return {
        kind: "not_found",
        error: createDiag(
          CompileDiagnosticCode.ProjectNotFound,
          "Could not find a .rigg directory from the current working directory.",
        ),
      }
    }

    currentDir = parentDir
  }
}

async function listFiles(riggDir: string): Promise<string[]> {
  try {
    const entries = await readdir(riggDir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile())
      .filter((entry) => {
        for (const extension of workflowFileExtensions) {
          if (entry.name.endsWith(extension)) {
            return true
          }
        }

        return false
      })
      .map((entry) => join(riggDir, entry.name))
      .sort()
  } catch (error) {
    throw createDiag(CompileDiagnosticCode.ReadFailed, "Failed to list workflow files.", {
      filePath: riggDir,
      cause: normalizeError(error),
    })
  }
}

async function readWorkspace(workspace: WorkspacePaths): Promise<WorkflowSourceFile[]> {
  try {
    const workflowFilePaths = await listFiles(workspace.riggDir)
    const files: WorkflowSourceFile[] = []

    for (const filePath of workflowFilePaths) {
      const text = await Bun.file(filePath).text()
      files.push({
        filePath,
        relativePath: relative(workspace.rootDir, filePath),
        text,
      })
    }

    return files
  } catch (error) {
    const cause = normalizeError(error)
    throw createDiag(CompileDiagnosticCode.ReadFailed, "Failed to read workflow files.", {
      filePath: workspace.riggDir,
      cause,
    })
  }
}

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
