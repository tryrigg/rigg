import type { NodePath } from "../../workflow/id"
import type { BranchNode, GroupNode, LoopNode, ParallelNode, WorkflowNode } from "../../workflow/schema"
import { elapsedMs, timestampNow } from "../../util/time"
import { normalizeExecError } from "../error"
import {
  createNodeSnapshot,
  currentNodeSnapshot,
  finishNode,
  finishThrownControlNode,
  startNode,
  statusForBinding,
  summarizeCompletedNode,
  type NodeLifecycle,
} from "../node"
import type { RunEvent } from "../event"
import type { StepBinding } from "../render"
import type { CompletedNodeSummary, RunReason, RunSnapshot } from "../schema"

export type ExecutionDisposition = "completed" | "failed" | "interrupted"
export type ControlNode = BranchNode | GroupNode | LoopNode | ParallelNode | WorkflowNode

export type StepExecutionOutcome = {
  bindingStatus: StepBinding["status"] | null
  completed: CompletedNodeSummary
  disposition: ExecutionDisposition
  reason: RunReason | undefined
  result: unknown
}

type ControlStepEnvironment = {
  emitEvent: (event: RunEvent) => void
  runState: RunSnapshot
}

export async function executeControlNode(
  environment: ControlStepEnvironment,
  step: ControlNode,
  nodePath: NodePath,
  run: (lifecycle: NodeLifecycle) => Promise<StepExecutionOutcome>,
): Promise<StepExecutionOutcome> {
  const lifecycle = startNode(environment.runState, step, nodePath, step.type, environment.emitEvent)
  try {
    return await run(lifecycle)
  } catch (error) {
    return handleThrownControlStep(environment, step, nodePath, lifecycle, error)
  }
}

export function finalizeControlStep(
  environment: ControlStepEnvironment,
  step: ControlNode,
  nodePath: NodePath,
  lifecycle: NodeLifecycle,
  disposition: ExecutionDisposition,
  reason: RunReason | undefined,
  result: unknown,
): StepExecutionOutcome {
  const finishedAt = timestampNow()
  const snapshot = createNodeSnapshot(step.id, nodePath, step.type, nodeStatusForDisposition(disposition), lifecycle)
  snapshot.duration_ms = elapsedMs(lifecycle.startedAt, finishedAt)
  snapshot.finished_at = finishedAt
  snapshot.progress = currentNodeSnapshot(environment.runState, nodePath)?.progress
  snapshot.result = result
  finishNode(environment.runState, snapshot, environment.emitEvent)

  return {
    bindingStatus: disposition === "interrupted" ? null : statusForBinding(snapshot.status),
    completed: summarizeCompletedNode(snapshot),
    disposition,
    reason,
    result,
  }
}

export function handleThrownControlStep(
  environment: ControlStepEnvironment,
  step: ControlNode,
  nodePath: NodePath,
  lifecycle: NodeLifecycle,
  error: unknown,
): StepExecutionOutcome {
  const snapshot = finishThrownControlNode(
    environment.runState,
    step,
    nodePath,
    lifecycle,
    error,
    environment.emitEvent,
  )
  if (snapshot.status === "interrupted") {
    return {
      bindingStatus: null,
      completed: summarizeCompletedNode(snapshot),
      disposition: "interrupted",
      reason: undefined,
      result: null,
    }
  }

  throw normalizeExecError(error, snapshot.status === "failed" ? "step_failed" : "engine_error")
}

export function nodeStatusForDisposition(disposition: ExecutionDisposition): "failed" | "interrupted" | "succeeded" {
  switch (disposition) {
    case "completed":
      return "succeeded"
    case "failed":
      return "failed"
    case "interrupted":
      return "interrupted"
  }
}
