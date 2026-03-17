import { lstat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { isMissingPathError } from "../util/error"
import { createCompileDiagnostic, CompileDiagnosticCode, type CompileDiagnostic } from "./diagnostic"
import type { WorkflowDocument } from "./schema"

export type WorkspacePaths = {
  rootDir: string
  riggDir: string
}

export type WorkflowSourceFile = {
  filePath: string
  relativePath: string
  text: string
}

export type DecodedWorkflowFile = {
  filePath: string
  relativePath: string
  workflow: WorkflowDocument
}

export type WorkflowProject = {
  workspace: WorkspacePaths
  files: DecodedWorkflowFile[]
}

export type WorkspaceDiscoveryResult =
  | { kind: "found"; workspace: WorkspacePaths }
  | { kind: "not_found"; error: CompileDiagnostic }

export async function discoverWorkspace(startDir: string): Promise<WorkspaceDiscoveryResult> {
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
        error: createCompileDiagnostic(
          CompileDiagnosticCode.ProjectNotFound,
          "Could not find a .rigg directory from the current working directory.",
        ),
      }
    }

    currentDir = parentDir
  }
}

export function workflowById(project: WorkflowProject, workflowId: string): WorkflowDocument | undefined {
  return project.files.find((file) => file.workflow.id === workflowId)?.workflow
}
