import { findWorkspace } from "../project"
import { getRunByPrefix, getRunView } from "../history/query"
import { renderAmbiguousPrefix, renderNoRuns, renderRunNotFound, renderRunView } from "../history/render"
import { serializeRun } from "../history/serialize"
import { findWorkspaceId } from "../project/store"
import { closeDb, openDb } from "../storage/db"
import { normalizeError } from "../util/error"
import { stringifyJson } from "../util/json"
import { type CommandResult, failure, PROJECT_NOT_FOUND_MESSAGE, success } from "./result"

export async function runCommand(cwd: string, runId: string | undefined, json = false): Promise<CommandResult> {
  if (runId === undefined) {
    return failure(["Usage: rigg show <run_id>"])
  }
  try {
    const workspace = await findWorkspace(cwd)
    if (workspace === null) {
      return failure([PROJECT_NOT_FOUND_MESSAGE])
    }

    const openResult = await openDb()
    if (openResult.kind === "disabled") {
      return failure(openResult.warning)
    }

    try {
      const workspaceId = findWorkspaceId(openResult.db, workspace.rootDir)
      if (workspaceId === null) {
        return failure(renderNoRuns())
      }

      const resolved = getRunByPrefix(openResult.db, workspaceId, runId)
      if (resolved.kind === "missing") {
        return failure(renderRunNotFound(runId, resolved.recent))
      }
      if (resolved.kind === "ambiguous") {
        return failure(renderAmbiguousPrefix(runId, resolved.matches))
      }

      const view = getRunView(openResult.db, resolved.runId)
      if (view === null) {
        return failure(renderRunNotFound(runId, []))
      }

      if (json) {
        return success([stringifyJson(serializeRun(view))])
      }

      return success(renderRunView(view))
    } finally {
      closeDb(openResult.db)
    }
  } catch (error) {
    return failure([normalizeError(error).message])
  }
}
