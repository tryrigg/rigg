import { comparePath, type NodePath } from "../workflow/id"
import type {
  NodeSnapshot,
  PendingInteraction,
  RunPhase,
  RunReason,
  RunSnapshot,
  RunStatus,
  StepBarrier,
} from "./schema"

export type MutableRunState = RunSnapshot
export type MutableNodeSnapshot = NodeSnapshot

export function initRunState(runId: string, workflowId: string, startedAt: string): MutableRunState {
  return {
    active_barrier: null,
    active_interaction: null,
    finished_at: null,
    nodes: [],
    phase: "running",
    reason: null,
    run_id: runId,
    started_at: startedAt,
    status: "running",
    workflow_id: workflowId,
  }
}

export function finishRun(
  state: MutableRunState,
  status: Exclude<RunStatus, "running">,
  reason: RunReason,
  finishedAt: string,
): void {
  state.status = status
  state.reason = reason
  state.finished_at = finishedAt
  state.active_barrier = null
  state.active_interaction = null
  recalcPhase(state)
}

export function upsertNode(state: MutableRunState, snapshot: MutableNodeSnapshot): void {
  const existingIndex = state.nodes.findIndex((node) => node.node_path === snapshot.node_path)
  if (existingIndex >= 0) {
    state.nodes[existingIndex] = snapshot
    return
  }

  let lo = 0
  let hi = state.nodes.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    const current = state.nodes[mid]
    if (current !== undefined && comparePath(current.node_path, snapshot.node_path) < 0) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  state.nodes.splice(lo, 0, snapshot)
}

export function nextAttempt(state: MutableRunState, nodePath: NodePath): number {
  const snapshot = state.nodes.find((node) => node.node_path === nodePath)
  return snapshot === undefined ? 1 : snapshot.attempt + 1
}

export function setBarrier(state: MutableRunState, barrier: StepBarrier | null): void {
  state.active_barrier = barrier
  recalcPhase(state)
}

export function setInteraction(state: MutableRunState, interaction: PendingInteraction | null): void {
  state.active_interaction = interaction
  recalcPhase(state)
}

export function recalcPhase(state: MutableRunState): void {
  state.phase = deriveRunPhase(state)
}

function deriveRunPhase(state: RunSnapshot): RunPhase {
  if (state.status === "succeeded") {
    return "completed"
  }
  if (state.status === "failed") {
    return "failed"
  }
  if (state.status === "aborted") {
    return "aborted"
  }
  if (state.active_interaction != null) {
    return phaseForInteraction(state.active_interaction)
  }
  if (state.active_barrier != null) {
    return "waiting_for_barrier"
  }

  return "running"
}

function phaseForInteraction(interaction: PendingInteraction): RunPhase {
  switch (interaction.kind) {
    case "approval":
      return "waiting_for_approval"
    case "user_input":
      return "waiting_for_question"
    case "elicitation":
      return "waiting_for_interaction"
  }
}
