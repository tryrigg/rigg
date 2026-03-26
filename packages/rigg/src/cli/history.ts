import { findWorkspace } from "../project"
import { listHistory } from "../history/query"
import { serializeRunSummary } from "../history/serialize"
import {
  renderEmptyHistoryPage,
  renderHistory,
  renderNoFilteredRuns,
  renderNoRuns,
  renderNoWorkflowRuns,
} from "../history/render"
import { findWorkspaceId } from "../project/store"
import { closeDb, openDb } from "../storage/db"
import type { RunStatus } from "../session/schema"
import { normalizeError } from "../util/error"
import { stringifyJson } from "../util/json"
import { type CommandResult, failure, PROJECT_NOT_FOUND_MESSAGE, success } from "./result"

function emptyResult(options: { json: boolean; workflowId?: string }, warning: string[] = []): CommandResult {
  if (options.json) {
    return success([stringifyJson([])], warning)
  }

  return success(options.workflowId === undefined ? renderNoRuns() : renderNoWorkflowRuns(options.workflowId), warning)
}

export async function runCommand(
  cwd: string,
  options: { json: boolean; limit: number; offset: number; status?: RunStatus; workflowId?: string },
): Promise<CommandResult> {
  try {
    const workspace = await findWorkspace(cwd)
    if (workspace === null) {
      return failure([PROJECT_NOT_FOUND_MESSAGE])
    }

    const openResult = await openDb()
    if (openResult.kind === "disabled") {
      return emptyResult(options, openResult.warning)
    }

    try {
      const workspaceId = findWorkspaceId(openResult.db, workspace.rootDir)
      if (workspaceId === null) {
        return emptyResult(options)
      }

      const filter = {
        limit: options.limit,
        offset: options.offset,
        workspaceId,
        ...(options.status !== undefined && { status: options.status }),
        ...(options.workflowId !== undefined && { workflowId: options.workflowId }),
      }
      const items = listHistory(openResult.db, filter)

      if (items.length === 0 && options.limit === 0) {
        if (options.json) {
          return success([stringifyJson([])])
        }
        return success([])
      }

      if (options.json) {
        return success([stringifyJson(items.map(serializeRunSummary))])
      }

      if (items.length === 0) {
        const filtered = listHistory(openResult.db, {
          ...filter,
          limit: 1,
          offset: 0,
        })

        if (filtered.length > 0) {
          return success(renderEmptyHistoryPage(options.offset, options))
        }

        const scopeFilter = options.workflowId === undefined ? {} : { workflowId: options.workflowId }
        const scoped = listHistory(openResult.db, {
          limit: 1,
          offset: 0,
          workspaceId,
          ...scopeFilter,
        })

        if (scoped.length === 0) {
          return success(options.workflowId === undefined ? renderNoRuns() : renderNoWorkflowRuns(options.workflowId))
        }

        if (options.status !== undefined) {
          return success(renderNoFilteredRuns({ status: options.status, ...scopeFilter }))
        }

        return success(renderNoRuns())
      }

      return success(renderHistory(items))
    } finally {
      closeDb(openResult.db)
    }
  } catch (error) {
    return failure([normalizeError(error).message])
  }
}
