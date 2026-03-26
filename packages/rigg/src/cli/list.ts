import { listWorkflowIds, scanProject } from "../project"
import { listWorkflowSummaries } from "../history/query"
import { renderWorkflowList } from "../history/render"
import { findWorkspaceId } from "../project/store"
import { closeDb, openDb } from "../storage/db"
import { StepKind, type WorkflowStep } from "../workflow/schema"
import { normalizeError } from "../util/error"
import { renderErrors } from "./out"
import { type CommandResult, failure, PROJECT_NOT_FOUND_MESSAGE, success } from "./result"

const ACTION_STEP_KINDS = new Set<string>([
  StepKind.Shell,
  StepKind.Claude,
  StepKind.Codex,
  StepKind.Cursor,
  StepKind.WriteFile,
  StepKind.Workflow,
])

function countSteps(steps: WorkflowStep[]): number {
  return steps.reduce((sum, step) => {
    if (ACTION_STEP_KINDS.has(step.type)) {
      return sum + 1
    }

    switch (step.type) {
      case "group":
      case "loop":
        return sum + countSteps(step.steps)
      case "branch":
        return sum + step.cases.reduce((caseSum, branchCase) => caseSum + countSteps(branchCase.steps), 0)
      case "parallel":
        return sum + step.branches.reduce((branchSum, branch) => branchSum + countSteps(branch.steps), 0)
    }

    return sum
  }, 0)
}

function duplicateIds(workflowIds: string[]): Set<string> {
  const counts = workflowIds.reduce((map, workflowId) => {
    map.set(workflowId, (map.get(workflowId) ?? 0) + 1)
    return map
  }, new Map<string, number>())

  return new Set([...counts].filter(([, count]) => count > 1).map(([workflowId]) => workflowId))
}

export async function runCommand(cwd: string): Promise<CommandResult> {
  try {
    const projectResult = await scanProject(cwd)
    if (projectResult.kind === "not_found") {
      return failure([PROJECT_NOT_FOUND_MESSAGE])
    }
    if (projectResult.kind === "invalid") {
      return failure(renderErrors(projectResult.errors))
    }

    const stderrLines = renderErrors(projectResult.errors)
    if (projectResult.project.files.length === 0) {
      if (projectResult.errors.length > 0) {
        return success([], stderrLines)
      }
      return success(["No workflows found. Create one with:", "", "  rigg init"], stderrLines)
    }

    const lastRunByWorkflow = new Map<string, ReturnType<typeof listWorkflowSummaries>[number]["lastRun"]>()
    const openResult = await openDb()
    if (openResult.kind === "disabled") {
      stderrLines.push(...openResult.warning)
    }
    if (openResult.kind === "ok") {
      try {
        const workspaceId = findWorkspaceId(openResult.db, projectResult.project.workspace.rootDir)
        if (workspaceId !== null) {
          for (const summary of listWorkflowSummaries(openResult.db, workspaceId)) {
            lastRunByWorkflow.set(summary.workflowId, summary.lastRun)
          }
        }
      } finally {
        closeDb(openResult.db)
      }
    }

    const fileByWorkflowId = new Map(projectResult.project.files.map((file) => [file.workflow.id, file]))
    const allIds = listWorkflowIds(projectResult.project)
    const blocked = duplicateIds(allIds)
    const workflowIds = allIds.filter((workflowId) => !blocked.has(workflowId))
    return success(
      renderWorkflowList(
        workflowIds.map((workflowId) => {
          const file = fileByWorkflowId.get(workflowId)
          return {
            lastRun: lastRunByWorkflow.get(workflowId) ?? null,
            stepCount: file ? countSteps(file.workflow.steps) : 0,
            workflowId,
          }
        }),
      ),
      stderrLines,
    )
  } catch (error) {
    return failure([normalizeError(error).message])
  }
}
