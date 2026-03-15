import type { FrameId, NodePath } from "../compile/schema"
import type { NodeStatus, RunReason, RunStatus } from "./schema"

export type StreamKind = "stdout" | "stderr"
export type LoopIterationOutcome = "continue" | "completed" | "failed"
export type BranchSelection = "if" | "else"
export type ProviderKind = "codex"

export type RunProgressEvent =
  | {
      kind: "run_started"
      node_count: number
      run_id: string
      workflow_id: string
    }
  | {
      attempt: number
      frame_id: FrameId
      kind: "node_started"
      node_kind: string
      node_path: NodePath
      provider: ProviderKind | null
      user_id: string | null
    }
  | {
      frame_id: FrameId
      kind: "node_skipped"
      node_path: NodePath
      reason: string
      user_id: string | null
    }
  | {
      case_index: number
      frame_id: FrameId
      kind: "branch_selected"
      node_path: NodePath
      selection: BranchSelection
      user_id: string | null
    }
  | {
      frame_id: FrameId
      iteration: number
      kind: "loop_iteration_started"
      max_iterations: number
      node_path: NodePath
      user_id: string | null
    }
  | {
      frame_id: FrameId
      iteration: number
      kind: "loop_iteration_finished"
      max_iterations: number
      node_path: NodePath
      outcome: LoopIterationOutcome
      user_id: string | null
    }
  | {
      chunk: string
      kind: "step_output"
      stream: StreamKind
    }
  | {
      detail: string | null
      frame_id: FrameId
      kind: "provider_tool_use"
      node_path: NodePath
      provider: ProviderKind
      tool: string
      user_id: string | null
    }
  | {
      frame_id: FrameId
      kind: "provider_status"
      message: string
      node_path: NodePath
      provider: ProviderKind
      user_id: string | null
    }
  | {
      frame_id: FrameId
      kind: "provider_error"
      message: string
      node_path: NodePath
      provider: ProviderKind
      user_id: string | null
    }
  | {
      duration_ms: number | null
      exit_code: number | null
      frame_id: FrameId
      kind: "node_finished"
      node_path: NodePath
      status: NodeStatus
      user_id: string | null
    }
  | {
      kind: "run_finished"
      reason: RunReason
      status: Exclude<RunStatus, "running">
    }
