import { compareNodePath, type NodePath } from "../compile/schema"
import type { NodeSnapshot, RunReason, RunSnapshot, RunStatus } from "./schema"

export type MutableRunState = RunSnapshot
export type MutableNodeSnapshot = NodeSnapshot

export function createInitialRunState(runId: string, workflowId: string, startedAt: string): MutableRunState {
  return {
    active_barrier: null,
    active_interaction: null,
    active_node_path: null,
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

export function setRunFinished(
  state: MutableRunState,
  status: Exclude<RunStatus, "running">,
  reason: RunReason,
  finishedAt: string,
): void {
  state.status = status
  state.reason = reason
  state.finished_at = finishedAt
  state.phase = status === "succeeded" ? "completed" : status
  state.active_barrier = null
  state.active_interaction = null
  state.active_node_path = null
}

export function upsertNodeSnapshot(state: MutableRunState, snapshot: MutableNodeSnapshot): void {
  const existingIndex = state.nodes.findIndex((node) => node.node_path === snapshot.node_path)
  if (existingIndex >= 0) {
    state.nodes[existingIndex] = snapshot
  } else {
    state.nodes.push(snapshot)
    state.nodes.sort((left, right) => compareNodePath(left.node_path, right.node_path))
  }
}

export function nextNodeAttempt(state: MutableRunState, nodePath: NodePath): number {
  const snapshot = state.nodes.find((node) => node.node_path === nodePath)
  return snapshot === undefined ? 1 : snapshot.attempt + 1
}
