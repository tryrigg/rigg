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

export type ScanProjectResult =
  | { kind: "ok"; errors: CompileDiagnostic[]; project: WorkflowProject }
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

export async function findWorkspace(startDir: string): Promise<WorkspacePaths | null> {
  const result = await discover(startDir)
  if (result.kind === "not_found") {
    return null
  }
  return result.workspace
}

async function listFiles(riggDir: string): Promise<string[]> {
  try {
    const entries = await readdir(riggDir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile())
      .filter((entry) => [...workflowFileExtensions].some((ext) => entry.name.endsWith(ext)))
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
    return await Promise.all(
      workflowFilePaths.map(async (filePath) => ({
        filePath,
        relativePath: relative(workspace.rootDir, filePath),
        text: await Bun.file(filePath).text(),
      })),
    )
  } catch (error) {
    const cause = normalizeError(error)
    throw createDiag(CompileDiagnosticCode.ReadFailed, "Failed to read workflow files.", {
      filePath: workspace.riggDir,
      cause,
    })
  }
}

export async function loadProject(startDir: string): Promise<LoadProjectResult> {
  const result = await scanProject(startDir)
  if (result.kind !== "ok") {
    return result
  }
  if (result.errors.length > 0) {
    return { kind: "invalid", errors: result.errors }
  }
  return { kind: "ok", project: result.project }
}

export async function scanProject(startDir: string): Promise<ScanProjectResult> {
  const workspace = await findWorkspace(startDir)
  if (workspace === null) {
    return { kind: "not_found" }
  }

  try {
    const sourceFiles = await readWorkspace(workspace)
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

    const project: WorkflowProject = {
      workspace,
      files,
    }

    return {
      kind: "ok",
      errors: [...errors, ...checkWorkspace(project)],
      project,
    }
  } catch (error) {
    const cause = normalizeError(error)
    return {
      kind: "invalid",
      errors: [isDiag(cause) ? cause : { code: "read_failed", message: cause.message, cause }],
    }
  }
}

export function listWorkflowIds(project: WorkflowProject): string[] {
  return project.files.map((file) => file.workflow.id).sort()
}

export function workflowById(project: WorkflowProject, workflowId: string): WorkflowDocument | undefined {
  return project.files.find((file) => file.workflow.id === workflowId)?.workflow
}
