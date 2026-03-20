import { readdir } from "node:fs/promises"
import { join, relative } from "node:path"

import { createDiag, CompileDiagnosticCode } from "../workflow/diag"
import type { WorkspacePaths, WorkflowSourceFile } from "./model"
import { normalizeError } from "../util/error"

const workflowFileExtensions = new Set([".yaml", ".yml"])

export async function listFiles(riggDir: string): Promise<string[]> {
  try {
    const entries = await readdir(riggDir, { withFileTypes: true })
    const filePaths = entries
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

    return filePaths
  } catch (error) {
    throw createDiag(CompileDiagnosticCode.ReadFailed, "Failed to list workflow files.", {
      filePath: riggDir,
      cause: normalizeError(error),
    })
  }
}

export async function readWorkspace(workspace: WorkspacePaths): Promise<WorkflowSourceFile[]> {
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
