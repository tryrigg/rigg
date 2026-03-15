import type { NodeSnapshot, RunReason, RunSnapshot, RunStatus } from "./schema"
import type { NodePath } from "../compile/schema"

export type MutableRunState = RunSnapshot
export type MutableNodeSnapshot = NodeSnapshot

export function createInitialRunState(runId: string, workflowId: string, startedAt: string): MutableRunState {
  return {
    finished_at: null,
    nodes: [],
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
}

export function upsertNodeSnapshot(state: MutableRunState, snapshot: MutableNodeSnapshot): void {
  const existingIndex = state.nodes.findIndex((node) => node.node_path === snapshot.node_path)
  if (existingIndex >= 0) {
    state.nodes[existingIndex] = snapshot
  } else {
    state.nodes.push(snapshot)
    state.nodes.sort((left, right) => left.node_path.localeCompare(right.node_path, undefined, { numeric: true }))
  }
}

export function nextNodeAttempt(state: MutableRunState, nodePath: NodePath): number {
  const snapshot = state.nodes.find((node) => node.node_path === nodePath)
  return snapshot === undefined ? 1 : snapshot.attempt + 1
}
