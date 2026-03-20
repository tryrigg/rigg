import { loadProject, listWorkflowIds } from "../project"
import { normalizeError } from "../util/error"
import { stringifyJson } from "../util/json"
import { renderErrors } from "./out"

type CommandResult = {
  exitCode: number
  stderrLines: string[]
  stdoutLines: string[]
}

function success(stdoutLines: string[] = [], stderrLines: string[] = []): CommandResult {
  return { exitCode: 0, stderrLines, stdoutLines }
}

function failure(stderrLines: string[] = [], exitCode = 1, stdoutLines: string[] = []): CommandResult {
  return { exitCode, stderrLines, stdoutLines }
}

const PROJECT_NOT_FOUND_MESSAGE = "Could not find a .rigg directory from the current working directory."

export async function runValidateCommand(cwd: string, json = false): Promise<CommandResult> {
  try {
    const result = await loadProject(cwd)
    if (result.kind === "not_found") {
      return failure([PROJECT_NOT_FOUND_MESSAGE])
    }
    if (result.kind === "invalid") {
      return failure(renderErrors(result.errors))
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
