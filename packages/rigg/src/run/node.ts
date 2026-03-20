import { childNodePath, type BranchCase, type NodePath, type WorkflowStep } from "../compile/schema"
import { workflowById, type WorkflowProject } from "../compile/project"
import { elapsedMs, timestampNow } from "../util/time"
import { RunExecutionError, isStepInterrupted, normalizeExecutionError } from "./error"
import type { RunEvent } from "./progress"
import type { StepBinding } from "./render"
import type { CompletedNodeSummary, NodeProgress, NodeSnapshot, NodeStatus, RunSnapshot } from "./schema"
import { nextNodeAttempt, recalculateRunPhase, upsertNodeSnapshot } from "./state"

export type NodeLifecycle = {
  attempt: number
  startedAt: string
}

type EmitEvent = (event: RunEvent) => void

export function currentNodeSnapshot(runState: RunSnapshot, nodePath: NodePath): NodeSnapshot | undefined {
  return runState.nodes.find((node) => node.node_path === nodePath)
}

export function recordSkippedStep(
  runState: RunSnapshot,
  step: WorkflowStep,
  nodePath: NodePath,
  reason: string,
  project: WorkflowProject | undefined,
  emitEvent: EmitEvent,
): NodeSnapshot {
  const snapshot = createNodeSnapshot(step.id, nodePath, step.type, "skipped", {
    attempt: nextNodeAttempt(runState, nodePath),
    startedAt: timestampNow(),
  })
  snapshot.duration_ms = 0
  snapshot.finished_at = snapshot.started_at
  snapshot.stderr = reason
  upsertNodeSnapshot(runState, snapshot)

  if (step.type === "group" || step.type === "loop") {
    markBlockSkipped(runState, step.steps, nodePath, project)
  }
  if (step.type === "branch") {
    for (const [index, caseNode] of step.cases.entries()) {
      markCaseSkipped(runState, caseNode, `${nodePath}/${index}`, project)
    }
  }
  if (step.type === "parallel") {
    for (const [index, branch] of step.branches.entries()) {
      markBlockSkipped(runState, branch.steps, `${nodePath}/${index}`, project)
    }
  }
  if (step.type === "workflow") {
    markSkippedWorkflow(runState, step, nodePath, project, [])
  }

  emitEvent({
    kind: "node_skipped",
    node: snapshot,
    reason,
    snapshot: runState,
  })

  return snapshot
}

export function startNode(
  runState: RunSnapshot,
  step: WorkflowStep,
  nodePath: NodePath,
  nodeKind: string,
  emitEvent: EmitEvent,
): NodeLifecycle {
  const lifecycle = {
    attempt: nextNodeAttempt(runState, nodePath),
    startedAt: timestampNow(),
  }
  const snapshot = createNodeSnapshot(step.id, nodePath, nodeKind, "running", lifecycle)
  upsertNodeSnapshot(runState, snapshot)
  recalculateRunPhase(runState)
  emitEvent({
    kind: "node_started",
    node: snapshot,
    snapshot: runState,
  })

  return lifecycle
}

export function startSyntheticNode(
  runState: RunSnapshot,
  nodePath: NodePath,
  nodeKind: string,
  emitEvent: EmitEvent,
  userId?: string,
): NodeLifecycle {
  const lifecycle = {
    attempt: nextNodeAttempt(runState, nodePath),
    startedAt: timestampNow(),
  }
  const snapshot = createNodeSnapshot(userId, nodePath, nodeKind, "running", lifecycle)
  upsertNodeSnapshot(runState, snapshot)
  recalculateRunPhase(runState)
  emitEvent({
    kind: "node_started",
    node: snapshot,
    snapshot: runState,
  })

  return lifecycle
}

export function finishNode(runState: RunSnapshot, snapshot: NodeSnapshot, emitEvent: EmitEvent): void {
  upsertNodeSnapshot(runState, snapshot)
  recalculateRunPhase(runState)
  emitEvent({
    kind: "node_completed",
    node: snapshot,
    snapshot: runState,
  })
}

export function finishThrownControlNode(
  runState: RunSnapshot,
  step: WorkflowStep,
  nodePath: NodePath,
  lifecycle: NodeLifecycle,
  error: unknown,
  emitEvent: EmitEvent,
): NodeSnapshot {
  const interrupted = isStepInterrupted(error)
  const status: NodeStatus = interrupted ? "interrupted" : "failed"
  const message = interrupted ? error.message : normalizeExecutionError(error).message
  const finishedAt = timestampNow()
  const snapshot = createNodeSnapshot(step.id, nodePath, step.type, status, lifecycle)
  snapshot.duration_ms = elapsedMs(lifecycle.startedAt, finishedAt)
  snapshot.finished_at = finishedAt
  snapshot.progress = currentNodeSnapshot(runState, nodePath)?.progress
  snapshot.stderr = message
  finishNode(runState, snapshot, emitEvent)
  return snapshot
}

export function createNodeSnapshot(
  userId: string | undefined,
  nodePath: NodePath,
  nodeKind: string,
  status: NodeStatus,
  lifecycle: NodeLifecycle,
): NodeSnapshot {
  return {
    attempt: lifecycle.attempt,
    duration_ms: null,
    exit_code: null,
    finished_at: null,
    node_kind: nodeKind,
    node_path: nodePath,
    progress: undefined,
    result: null,
    started_at: lifecycle.startedAt,
    status,
    stderr: null,
    stdout: null,
    user_id: userId ?? null,
    waiting_for: null,
  }
}

export function summarizeCompletedNode(snapshot: NodeSnapshot): CompletedNodeSummary {
  return {
    node_kind: snapshot.node_kind,
    node_path: snapshot.node_path,
    result: snapshot.result ?? null,
    status: snapshot.status,
    user_id: snapshot.user_id ?? null,
  }
}

export function preview(value: string): string {
  return value.replaceAll("\n", "\\n").slice(0, 160)
}

export function statusForBinding(status: NodeStatus): StepBinding["status"] {
  if (status === "failed" || status === "pending" || status === "skipped" || status === "succeeded") {
    return status
  }

  throw new Error(`node status ${status} cannot be stored in step bindings`)
}

export function markCaseSkipped(
  runState: RunSnapshot,
  caseNode: BranchCase,
  pathPrefix: string,
  project?: WorkflowProject,
  activeWorkflowIds: string[] = [],
): void {
  const snapshot = createNodeSnapshot(undefined, pathPrefix, "branch_case", "skipped", {
    attempt: nextNodeAttempt(runState, pathPrefix),
    startedAt: timestampNow(),
  })
  snapshot.duration_ms = 0
  snapshot.finished_at = snapshot.started_at
  upsertNodeSnapshot(runState, snapshot)
  markBlockSkipped(runState, caseNode.steps, pathPrefix, project, activeWorkflowIds)
}

export function setNodeProgress(runState: RunSnapshot, nodePath: NodePath, progress: NodeProgress | undefined): void {
  const snapshot = currentNodeSnapshot(runState, nodePath)
  if (snapshot === undefined) {
    return
  }

  snapshot.progress = progress
  upsertNodeSnapshot(runState, snapshot)
}

function markBlockSkipped(
  runState: RunSnapshot,
  steps: WorkflowStep[],
  pathPrefix: string,
  project?: WorkflowProject,
  activeWorkflowIds: string[] = [],
): void {
  for (const [index, step] of steps.entries()) {
    const nodePath = childNodePath(pathPrefix, index)
    const snapshot = createNodeSnapshot(step.id, nodePath, step.type, "skipped", {
      attempt: nextNodeAttempt(runState, nodePath),
      startedAt: timestampNow(),
    })
    snapshot.duration_ms = 0
    snapshot.finished_at = snapshot.started_at
    upsertNodeSnapshot(runState, snapshot)

    if (step.type === "group" || step.type === "loop") {
      markBlockSkipped(runState, step.steps, nodePath, project, activeWorkflowIds)
    }
    if (step.type === "branch") {
      for (const [caseIndex, caseNode] of step.cases.entries()) {
        markCaseSkipped(runState, caseNode, `${nodePath}/${caseIndex}`, project, activeWorkflowIds)
      }
    }
    if (step.type === "parallel") {
      for (const [branchIndex, branch] of step.branches.entries()) {
        markBlockSkipped(runState, branch.steps, `${nodePath}/${branchIndex}`, project, activeWorkflowIds)
      }
    }
    if (step.type === "workflow") {
      markSkippedWorkflow(runState, step, nodePath, project, activeWorkflowIds)
    }
  }
}

function markSkippedWorkflow(
  runState: RunSnapshot,
  step: Extract<WorkflowStep, { type: "workflow" }>,
  nodePath: NodePath,
  project: WorkflowProject | undefined,
  activeWorkflowIds: string[],
): void {
  if (project === undefined) {
    return
  }

  const workflow = workflowById(project, step.with.workflow)
  if (workflow === undefined) {
    return
  }

  if (activeWorkflowIds.includes(workflow.id)) {
    throw new RunExecutionError(
      `Step \`${step.id ?? nodePath}\` creates a circular workflow reference: ${formatWorkflowCycle([
        ...activeWorkflowIds,
        workflow.id,
      ])}.`,
      {
        runReason: "validation_error",
      },
    )
  }

  markBlockSkipped(runState, workflow.steps, nodePath, project, [...activeWorkflowIds, workflow.id])
}

function formatWorkflowCycle(workflowIds: string[]): string {
  return workflowIds.join(" -> ")
}
