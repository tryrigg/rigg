import { childPath, rootPath } from "../../workflow/id"
import { StepKind, isRetryableStep, type WorkflowDocument, type WorkflowStep } from "../../workflow/schema"
import { workflowById, type WorkflowProject } from "../../project"
import type { NodeStatus, RunSnapshot, NodeSnapshot } from "../../session/schema"
import { formatLoopReason } from "../out"
import type { RetryingState } from "../state"
import { formatDuration } from "./symbols"

type TreeStatus = NodeStatus | "not_started" | "retrying"

export const ACTION_KINDS = new Set<string>([
  StepKind.Shell,
  StepKind.Claude,
  StepKind.Codex,
  StepKind.Cursor,
  StepKind.WriteFile,
])
export const SUMMARY_KINDS = new Set<string>([
  StepKind.Shell,
  StepKind.Claude,
  StepKind.Codex,
  StepKind.Cursor,
  StepKind.WriteFile,
  StepKind.Group,
  StepKind.Loop,
  StepKind.Branch,
  StepKind.Parallel,
  StepKind.Workflow,
])

export type TreeEntry = {
  entryType: "step" | "label"
  depth: number
  prefix: string
  retrying?: RetryingState | undefined
  status: TreeStatus
  label: string
  suffix: string
  nodePath: string
  nodeKind: string
  isActive: boolean
  isNext: boolean
  meta?: string | undefined
  detail?: string | undefined
}

type NodeMap = Map<string, NodeSnapshot>

const ACTIVE_STEP_STATUSES = new Set<NodeStatus>(["running", "waiting_for_interaction"])

function buildNodeMap(snapshot: RunSnapshot | null): NodeMap {
  if (snapshot === null) {
    return new Map()
  }
  return new Map(snapshot.nodes.map((n) => [n.node_path, n]))
}

function nodeStatus(nodeMap: NodeMap, nodePath: string): NodeStatus | "not_started" {
  const node = nodeMap.get(nodePath)
  return node === undefined ? "not_started" : node.status
}

const DISPLAY_STATUS_PRIORITY: Array<NodeStatus | "not_started"> = [
  "waiting_for_interaction",
  "running",
  "failed",
  "interrupted",
  "pending",
  "succeeded",
  "skipped",
  "not_started",
]

function descendantStatuses(nodeMap: NodeMap, nodePath: string): NodeStatus[] {
  const prefix = `${nodePath}/`
  const statuses: NodeStatus[] = []
  for (const [candidatePath, node] of nodeMap) {
    if (candidatePath.startsWith(prefix)) {
      statuses.push(node.status)
    }
  }
  return statuses
}

function aggregateDisplayStatus(statuses: Array<NodeStatus | "not_started">): NodeStatus | "not_started" {
  for (const status of DISPLAY_STATUS_PRIORITY) {
    if (statuses.includes(status)) {
      return status
    }
  }
  return "not_started"
}

function branchCaseStatus(nodeMap: NodeMap, casePath: string): NodeStatus | "not_started" {
  const directStatus = nodeStatus(nodeMap, casePath)
  if (directStatus !== "not_started") {
    return directStatus
  }
  return aggregateDisplayStatus(descendantStatuses(nodeMap, casePath))
}

function displayStatus(
  nodeMap: NodeMap,
  nodePath: string,
  retryingByNodePath: Record<string, RetryingState>,
): TreeStatus {
  if (retryingByNodePath[nodePath] !== undefined) {
    return "retrying"
  }
  return nodeStatus(nodeMap, nodePath)
}

function isActiveStepStatus(status: TreeStatus): boolean {
  return status === "retrying" || (status !== "not_started" && ACTIVE_STEP_STATUSES.has(status))
}

function isTerminalSnapshot(snapshot: RunSnapshot | null): boolean {
  if (snapshot === null) {
    return false
  }
  return (
    snapshot.phase === "completed" ||
    snapshot.phase === "failed" ||
    snapshot.phase === "aborted" ||
    snapshot.phase === "interrupted"
  )
}

function durationSuffix(nodeMap: NodeMap, nodePath: string): string {
  const node = nodeMap.get(nodePath)
  if (node === undefined || node.duration_ms === null || node.duration_ms === undefined) {
    return ""
  }
  return formatDuration(node.duration_ms)
}

function joinSuffix(...parts: Array<string | undefined>): string {
  return parts.filter((part) => part !== undefined && part.length > 0).join(" · ")
}

function joinDetail(...parts: Array<string | undefined>): string | undefined {
  const detail = joinSuffix(...parts)
  return detail.length > 0 ? detail : undefined
}

function retryMax(retry: number | { max: number }): number {
  return typeof retry === "number" ? retry : retry.max
}

function retrySuffix(
  step: WorkflowStep,
  nodeMap: NodeMap,
  nodePath: string,
  retryingByNodePath: Record<string, RetryingState>,
): string {
  if (!isRetryableStep(step) || step.retry === undefined) {
    return ""
  }

  const retrying = retryingByNodePath[nodePath]
  const max = retryMax(step.retry)
  if (retrying !== undefined) {
    return `attempt ${retrying.attempt + 1}/${max}`
  }

  const attempt = nodeMap.get(nodePath)?.attempt
  if (attempt === undefined) {
    return `attempt 1/${max}`
  }

  return `attempt ${attempt}/${max}`
}

export function extractDetail(step: WorkflowStep): string | undefined {
  switch (step.type) {
    case "shell": {
      const cmd = step.with.command
      const first = cmd.split("\n")[0] ?? cmd
      const trimmed = first.length > 60 ? first.slice(0, 57) + "..." : first
      return `$ ${trimmed}`
    }
    case "codex":
      return step.with.kind === "review"
        ? joinDetail("review", step.with.model)
        : joinDetail(
            "turn",
            step.with.collaboration_mode === "plan" ? "plan" : undefined,
            step.with.model,
            step.with.effort,
          )
    case "claude":
      return joinDetail("claude", step.with.model, step.with.permission_mode, step.with.effort)
    case "cursor":
      return joinDetail(step.with.mode ?? "agent", step.with.model)
    case "write_file":
      return `→ ${step.with.path}`
    default:
      return undefined
  }
}

function loopIteration(nodeMap: NodeMap, nodePath: string): number {
  return nodeMap.get(nodePath)?.progress?.current_iteration ?? 0
}

function loopMaxIterations(nodeMap: NodeMap, nodePath: string, fallback: number): number {
  return nodeMap.get(nodePath)?.progress?.max_iterations ?? fallback
}

function walkSteps(
  steps: WorkflowStep[],
  nodeMap: NodeMap,
  retryingByNodePath: Record<string, RetryingState>,
  parentPath: string | null,
  depth: number,
  prefix: string,
  entries: TreeEntry[],
  project?: WorkflowProject,
): void {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    if (step === undefined) {
      continue
    }
    const nodePath = parentPath === null ? rootPath(i) : childPath(parentPath, i)
    walkStep(step, nodeMap, retryingByNodePath, nodePath, depth, prefix, entries, project)
  }
}

function walkStep(
  step: WorkflowStep,
  nodeMap: NodeMap,
  retryingByNodePath: Record<string, RetryingState>,
  nodePath: string,
  depth: number,
  prefix: string,
  entries: TreeEntry[],
  project?: WorkflowProject,
): void {
  const status = displayStatus(nodeMap, nodePath, retryingByNodePath)
  const label = step.id ?? step.type
  const suffix = joinSuffix(
    retrySuffix(step, nodeMap, nodePath, retryingByNodePath),
    formatLoopReason(nodeMap.get(nodePath)?.result),
    durationSuffix(nodeMap, nodePath),
  )
  const isActive = isActiveStepStatus(status)
  const retrying = retryingByNodePath[nodePath]

  switch (step.type) {
    case "shell":
    case "claude":
    case "codex":
    case "cursor":
    case "write_file":
      entries.push({
        entryType: "step",
        depth,
        prefix,
        status,
        label,
        suffix,
        nodePath,
        nodeKind: step.type,
        isActive,
        isNext: false,
        detail: extractDetail(step),
        retrying,
      })
      return
    case "group": {
      const meta = `${step.steps.length} steps`
      entries.push({
        entryType: "step",
        depth,
        prefix,
        status,
        label,
        suffix,
        nodePath,
        nodeKind: "group",
        isActive,
        isNext: false,
        meta,
        retrying,
      })
      walkSteps(step.steps, nodeMap, retryingByNodePath, nodePath, depth + 1, prefix + "│  ", entries, project)
      return
    }
    case "loop": {
      const iterCount = loopIteration(nodeMap, nodePath)
      const maxIterations = loopMaxIterations(nodeMap, nodePath, step.max)
      const meta = `iter ${iterCount}/${maxIterations} · max ${maxIterations}`
      entries.push({
        entryType: "step",
        depth,
        prefix,
        status,
        label,
        suffix,
        nodePath,
        nodeKind: "loop",
        isActive,
        isNext: false,
        meta,
        retrying,
      })
      if (iterCount > 0) {
        entries.push({
          entryType: "label",
          depth: depth + 1,
          prefix: prefix + "│  ",
          status: "not_started",
          label: `iteration ${iterCount}`,
          suffix: "",
          nodePath: nodePath + "/__iter_label",
          nodeKind: "loop",
          isActive: false,
          isNext: false,
        })
      }
      walkSteps(step.steps, nodeMap, retryingByNodePath, nodePath, depth + 1, prefix + "│  ", entries, project)
      return
    }
    case "workflow": {
      const workflow = project === undefined ? undefined : workflowById(project, step.with.workflow)
      const childStepCount = workflow?.steps.length ?? 0
      entries.push({
        entryType: "step",
        depth,
        prefix,
        status,
        label,
        suffix,
        nodePath,
        nodeKind: "workflow",
        isActive,
        isNext: false,
        detail: `→ ${step.with.workflow}`,
        meta: `${step.with.workflow} · ${childStepCount} steps`,
        retrying,
      })
      if (workflow !== undefined) {
        walkSteps(workflow.steps, nodeMap, retryingByNodePath, nodePath, depth + 1, prefix + "│  ", entries, project)
      }
      return
    }
    case "branch":
      entries.push({
        entryType: "step",
        depth,
        prefix,
        status,
        label,
        suffix,
        nodePath,
        nodeKind: "branch",
        isActive,
        isNext: false,
        retrying,
      })
      for (let ci = 0; ci < step.cases.length; ci++) {
        const branchCase = step.cases[ci]
        if (branchCase === undefined) {
          continue
        }
        const caseLabel = branchCase.else === true ? "else" : (branchCase.if ?? `case ${ci}`)
        const casePath = childPath(nodePath, ci)
        entries.push({
          entryType: "step",
          depth: depth + 1,
          prefix: prefix + "│  ",
          status: branchCaseStatus(nodeMap, casePath),
          label: caseLabel,
          suffix: "",
          nodePath: casePath,
          nodeKind: "branch_case",
          isActive: false,
          isNext: false,
        })
        walkSteps(
          branchCase.steps,
          nodeMap,
          retryingByNodePath,
          casePath,
          depth + 2,
          prefix + "│     ",
          entries,
          project,
        )
      }
      return
    case "parallel": {
      const meta = `${step.branches.length} branches`
      entries.push({
        entryType: "step",
        depth,
        prefix,
        status,
        label,
        suffix,
        nodePath,
        nodeKind: "parallel",
        isActive,
        isNext: false,
        meta,
        retrying,
      })
      for (let bi = 0; bi < step.branches.length; bi++) {
        const branch = step.branches[bi]
        if (branch === undefined) {
          continue
        }
        const branchPath = childPath(nodePath, bi)
        if (branch.id) {
          entries.push({
            entryType: "label",
            depth: depth + 1,
            prefix: prefix + "│  ",
            status: "not_started",
            label: branch.id,
            suffix: "",
            nodePath: branchPath + "/__label",
            nodeKind: "parallel",
            isActive: false,
            isNext: false,
          })
        }
        walkSteps(branch.steps, nodeMap, retryingByNodePath, branchPath, depth + 1, prefix + "│  ", entries, project)
      }
      return
    }
  }
}

function annotateNext(entries: TreeEntry[], snapshot: RunSnapshot | null): void {
  if (isTerminalSnapshot(snapshot)) {
    return
  }

  const barrierFrontier = snapshot?.active_barrier?.next ?? []
  if (barrierFrontier.length > 0) {
    const frontierNodePaths = new Set(barrierFrontier.map((node) => node.node_path))
    for (const entry of entries) {
      if (entry.entryType === "step" && frontierNodePaths.has(entry.nodePath)) {
        entry.isNext = true
      }
    }
  }
}

export function buildTree(
  workflow: WorkflowDocument,
  snapshot: RunSnapshot | null,
  project?: WorkflowProject,
  retryingByNodePath: Record<string, RetryingState> = {},
): TreeEntry[] {
  const entries: TreeEntry[] = []
  const nodeMap = buildNodeMap(snapshot)
  walkSteps(workflow.steps, nodeMap, retryingByNodePath, null, 0, "", entries, project)
  annotateNext(entries, snapshot)
  return entries
}
