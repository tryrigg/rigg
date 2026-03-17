import { StepKind, childNodePath, rootNodePath } from "../../compile/schema"
import type { WorkflowDocument, WorkflowStep } from "../../compile/schema"
import type { NodeSnapshot, RunSnapshot } from "../../run/schema"

const ACTION_STEP_KINDS = new Set<string>([StepKind.Shell, StepKind.Codex, StepKind.WriteFile])

export type StepProgressSummary = {
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
): void {
  for (const [index, step] of steps.entries()) {
    const nodePath = parentPath === null ? rootNodePath(index) : childNodePath(parentPath, index)
    switch (step.type) {
      case "shell":
      case "codex":
      case "write_file":
        actionNodes.set(nodePath, { insideLoop })
        break
      case "group":
        collectActionNodes(step.steps, nodePath, insideLoop, actionNodes)
        break
      case "loop":
        collectActionNodes(step.steps, nodePath, true, actionNodes)
        break
      case "branch":
        for (const [caseIndex, branchCase] of step.cases.entries()) {
          collectActionNodes(branchCase.steps, childNodePath(nodePath, caseIndex), insideLoop, actionNodes)
        }
        break
      case "parallel":
        for (const [branchIndex, branch] of step.branches.entries()) {
          collectActionNodes(branch.steps, childNodePath(nodePath, branchIndex), insideLoop, actionNodes)
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

export function summarizeStepProgress(
  workflow: WorkflowDocument,
  snapshot: RunSnapshot | null,
): StepProgressSummary | null {
  if (snapshot === null) {
    return null
  }

  const actionNodes = new Map<string, ActionNodeInfo>()
  collectActionNodes(workflow.steps, null, false, actionNodes)

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
    const staticExecutions = info === undefined || info.insideLoop ? 0 : 1
    completed += completedExecutions(node)
    total += Math.max(0, knownExecutions(node) - staticExecutions)
  }

  for (const frontierNode of snapshot.active_barrier?.next ?? []) {
    if (!isActionNodeKind(frontierNode.node_kind)) {
      continue
    }

    const info = actionNodes.get(frontierNode.node_path)
    const priorExecution = nodeMap.get(frontierNode.node_path)
    if (info?.insideLoop === true || priorExecution !== undefined) {
      total += 1
    }
  }

  return total > 0 ? { completed, total } : null
}

export function formatStepProgress(summary: StepProgressSummary | null): string | undefined {
  if (summary === null || summary.total === 0) {
    return undefined
  }

  return `${summary.completed}/${summary.total} steps`
}
