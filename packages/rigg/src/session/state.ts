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
    finished_at: null,
    nodes: [],
    phase: "running",
    reason: null,
    run_id: runId,
    started_at: startedAt,
    status: "running",
    waiting: { kind: "none" },
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
  state.waiting = { kind: "none" }
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

export function clearStaleChildNodes(state: MutableRunState, nodePath: NodePath, seen: ReadonlySet<NodePath>): void {
  const prefix = `${nodePath}/`
  state.nodes = state.nodes.filter((node) => !node.node_path.startsWith(prefix) || seen.has(node.node_path))
}

export function setBarrier(state: MutableRunState, barrier: StepBarrier | null): void {
  state.waiting = barrier === null ? { kind: "none" } : { barrier, kind: "barrier" }
  recalcPhase(state)
}

export function setInteraction(state: MutableRunState, interaction: PendingInteraction | null): void {
  state.waiting = interaction === null ? { kind: "none" } : { interaction, kind: "interaction" }
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

  switch (state.waiting.kind) {
    case "interaction":
      return phaseForInteraction(state.waiting.interaction)
    case "barrier":
      return "waiting_for_barrier"
    case "none":
      return "running"
  }
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
