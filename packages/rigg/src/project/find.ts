import { lstat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { createDiag, CompileDiagnosticCode, type CompileDiagnostic } from "../workflow/diag"
import { isMissingPathError } from "../util/error"
import type { WorkspacePaths } from "./model"

export type WorkspaceDiscoveryResult =
  | { kind: "found"; workspace: WorkspacePaths }
  | { kind: "not_found"; error: CompileDiagnostic }

export async function discover(startDir: string): Promise<WorkspaceDiscoveryResult> {
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
