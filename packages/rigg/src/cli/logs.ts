import { findWorkspace } from "../project"
import { findLatestRun, getRunByPrefix, getRunView, resolveLogView, resolveStepSelector } from "../history/query"
import type { Run } from "../history/query"
import {
  hasLogOutput,
  hasStepOutput,
  renderAmbiguousStep,
  renderAmbiguousPrefix,
  renderLogView,
  renderNoRunOutput,
  renderMissingStep,
  renderNoRuns,
  renderNoStepOutput,
  renderRunNotFound,
} from "../history/render"
import { serializeRunLog } from "../history/serialize"
import { findWorkspaceId } from "../project/store"
import { closeDb, openDb, type Db } from "../storage/db"
import { normalizeError } from "../util/error"
import { stringifyJson } from "../util/json"
import { type CommandResult, failure, PROJECT_NOT_FOUND_MESSAGE, success } from "./result"

function hasStep(run: Run, stepName: string): boolean {
  return resolveStepSelector(run.steps, stepName).kind !== "missing"
}

function hasRunStep(db: Db, workspaceId: string, runId: string, stepName: string): boolean {
  const run = getRunByPrefix(db, workspaceId, runId)
  if (run.kind !== "ok") {
    return false
  }

  const view = getRunView(db, run.runId)
  if (view === null) {
    return false
  }

  return hasStep(view, stepName)
}

function resolveFirst(db: Db, workspaceId: string, first: string) {
  const latestRun = findLatestRun(db, workspaceId)
  if (latestRun === null) {
    return { run: undefined, step: undefined }
  }

  const latestWorkflowRun = findLatestRun(db, workspaceId, first)
  if (latestWorkflowRun !== null) {
    return { run: latestWorkflowRun.runId, step: undefined }
  }

  const latestView = getRunView(db, latestRun.runId)
  if (latestView !== null && hasStep(latestView, first)) {
    return { run: latestRun.runId, step: first }
  }

  return { run: first, step: undefined }
}

function resolveArgs(
  db: Db,
  workspaceId: string,
  options: { first?: string; run?: string; second?: string; step?: string },
) {
  const explicitRun = options.run
  const explicitStep = options.step

  if (explicitStep !== undefined && explicitRun === undefined) {
    if (options.first === undefined) {
      return { run: undefined, step: explicitStep }
    }
    const resolved = resolveFirst(db, workspaceId, options.first)
    return { run: resolved.run, step: explicitStep }
  }

  if (explicitRun !== undefined) {
    if (options.second !== undefined) {
      return { run: explicitRun, step: explicitStep ?? options.second }
    }
    if (explicitStep !== undefined) {
      return { run: explicitRun, step: explicitStep }
    }
    if (options.first !== undefined && options.first !== explicitRun) {
      if (hasRunStep(db, workspaceId, explicitRun, options.first)) {
        return { run: explicitRun, step: options.first }
      }
      const resolved = resolveFirst(db, workspaceId, options.first)
      if (resolved.step !== undefined) {
        return { run: explicitRun, step: resolved.step }
      }
      if (resolved.run !== options.first) {
        return { run: explicitRun, step: undefined }
      }
      return { run: explicitRun, step: options.first }
    }
    return { run: explicitRun, step: undefined }
  }

  if (options.first !== undefined && options.second !== undefined) {
    return { run: options.first, step: options.second }
  }

  if (options.first === undefined) {
    return { run: undefined, step: undefined }
  }

  return resolveFirst(db, workspaceId, options.first)
}

export async function runCommand(
  cwd: string,
  options: { first?: string; json: boolean; run?: string; second?: string; step?: string },
): Promise<CommandResult> {
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

      const resolved = resolveArgs(openResult.db, workspaceId, options)
      let resolvedRun = resolved.run
      const resolvedStep = resolved.step

      if (resolvedRun === undefined) {
        const latestRun = findLatestRun(openResult.db, workspaceId)
        if (latestRun === null) {
          return failure(renderNoRuns())
        }
        resolvedRun = latestRun.runId
      }

      const resolvedPrefix = getRunByPrefix(openResult.db, workspaceId, resolvedRun)
      if (resolvedPrefix.kind === "missing") {
        return failure(renderRunNotFound(resolvedRun, resolvedPrefix.recent))
      }
      if (resolvedPrefix.kind === "ambiguous") {
        return failure(renderAmbiguousPrefix(resolvedRun, resolvedPrefix.matches))
      }

      const log = resolveLogView(openResult.db, resolvedPrefix.runId, resolvedStep)
      if (log === null) {
        return failure(renderRunNotFound(resolvedRun, []))
      }
      if (log.kind === "ambiguous_step") {
        return failure(renderAmbiguousStep(resolvedStep!, log.run.shortId, log.matches))
      }
      if (log.kind === "missing_step") {
        return failure(renderMissingStep(resolvedStep!, log.run.shortId, log.run.steps))
      }

      const logView = log.view
      if (resolvedStep !== undefined && !logView.steps.some((step) => hasStepOutput(step))) {
        return failure(renderNoStepOutput(resolvedStep, logView.shortId, logView.recordingStatus))
      }
      if (resolvedStep === undefined && !hasLogOutput(logView)) {
        return failure(renderNoRunOutput(logView.shortId, logView.recordingStatus))
      }

      if (options.json) {
        return success([stringifyJson(serializeRunLog(logView))])
      }

      return success(renderLogView(logView))
    } finally {
      closeDb(openResult.db)
    }
  } catch (error) {
    return failure([normalizeError(error).message])
  }
}
