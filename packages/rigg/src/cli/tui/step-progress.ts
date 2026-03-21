import { childPath, rootPath } from "../../workflow/id"
import { StepKind, type WorkflowDocument, type WorkflowStep } from "../../workflow/schema"
import type { WorkflowProject } from "../../project"
import type { NodeSnapshot, RunSnapshot } from "../../session/schema"

const ACTION_STEP_KINDS = new Set<string>([
  StepKind.Shell,
  StepKind.Codex,
  StepKind.Cursor,
  StepKind.WriteFile,
  StepKind.Workflow,
])

export type ProgressSummary = {
  completed: number
  total: number
}

type ActionNodeInfo = {
  insideLoop: boolean
}

function collectActionNodes(
  steps: WorkflowStep[],
  parentPath: string | null,
  insideLoop: boolean,
  actionNodes: Map<string, ActionNodeInfo>,
  project?: WorkflowProject,
): void {
  for (const [index, step] of steps.entries()) {
    const nodePath = parentPath === null ? rootPath(index) : childPath(parentPath, index)
    switch (step.type) {
      case "shell":
      case "codex":
      case "cursor":
      case "write_file":
      case "workflow":
        actionNodes.set(nodePath, { insideLoop })
        break
      case "group":
        collectActionNodes(step.steps, nodePath, insideLoop, actionNodes, project)
        break
      case "loop":
        collectActionNodes(step.steps, nodePath, true, actionNodes, project)
        break
      case "branch":
        for (const [caseIndex, branchCase] of step.cases.entries()) {
          collectActionNodes(branchCase.steps, childPath(nodePath, caseIndex), insideLoop, actionNodes, project)
        }
        break
      case "parallel":
        for (const [branchIndex, branch] of step.branches.entries()) {
          collectActionNodes(branch.steps, childPath(nodePath, branchIndex), insideLoop, actionNodes, project)
        }
        break
    }
  }
}

function isActionNodeKind(nodeKind: string): boolean {
  return ACTION_STEP_KINDS.has(nodeKind)
}

function isCompletedNode(node: NodeSnapshot): boolean {
  return node.status === "succeeded" || node.status === "failed" || node.status === "skipped"
}

function completedExecutions(node: NodeSnapshot): number {
  return isCompletedNode(node) ? node.attempt : Math.max(0, node.attempt - 1)
}

function knownExecutions(node: NodeSnapshot): number {
  return node.attempt
}

export function summarize(
  workflow: WorkflowDocument,
  snapshot: RunSnapshot | null,
  project?: WorkflowProject,
): ProgressSummary | null {
  if (snapshot === null) {
    return null
  }

  const actionNodes = new Map<string, ActionNodeInfo>()
  collectActionNodes(workflow.steps, null, false, actionNodes, project)

  let completed = 0
  let total = 0

  for (const info of actionNodes.values()) {
    if (!info.insideLoop) {
      total += 1
    }
  }

  const nodeMap = new Map(snapshot.nodes.map((node) => [node.node_path, node]))
  for (const node of snapshot.nodes) {
    if (!isActionNodeKind(node.node_kind)) {
      continue
    }

    const info = actionNodes.get(node.node_path)
    if (info === undefined) {
      continue
    }
    const staticExecutions = info.insideLoop ? 0 : 1
    completed += completedExecutions(node)
    total += Math.max(0, knownExecutions(node) - staticExecutions)
  }

  for (const frontierNode of snapshot.active_barrier?.next ?? []) {
    if (!isActionNodeKind(frontierNode.node_kind)) {
      continue
    }

    const info = actionNodes.get(frontierNode.node_path)
    if (info === undefined) {
      continue
    }
    const priorExecution = nodeMap.get(frontierNode.node_path)
    if (info.insideLoop || priorExecution !== undefined) {
      total += 1
    }
  }

  return total > 0 ? { completed, total } : null
}

export function formatProgress(summary: ProgressSummary | null): string | undefined {
  if (summary === null || summary.total === 0) {
    return undefined
  }

  return `${summary.completed}/${summary.total} steps`
}
