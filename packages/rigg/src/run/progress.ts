import type { FrameId, NodePath } from "../compile/schema"
import type { NodeStatus, RunReason, RunStatus } from "../history/index"

export type StreamKind = "stdout" | "stderr"
export type LoopIterationOutcome = "continue" | "completed" | "failed"
export type BranchSelection = "if" | "else"
export type ProviderKind = "claude" | "codex"

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
      stderr_path: string | null
      stdout_path: string | null
      user_id: string | null
    }
  | {
      kind: "run_finished"
      reason: RunReason
      status: Exclude<RunStatus, "running">
    }

export type RecordedRunEvent =
  | ({
      cwd: string
      node_count: number
      run_id: string
      workflow_id: string
    } & { kind: "run_started"; ts: string })
  | ({
      attempt: number
      command: string
      frame_id: FrameId
      node_kind: string
      node_path: NodePath
      provider: ProviderKind | null
      user_id: string | null
    } & { kind: "node_started"; ts: string })
  | ({
      frame_id: FrameId
      node_path: NodePath
      reason: string
      user_id: string | null
    } & { kind: "node_skipped"; ts: string })
  | ({
      case_index: number
      frame_id: FrameId
      node_path: NodePath
      selection: BranchSelection
      user_id: string | null
    } & { kind: "branch_selected"; ts: string })
  | ({
      frame_id: FrameId
      iteration: number
      max_iterations: number
      node_path: NodePath
      user_id: string | null
    } & { kind: "loop_iteration_started"; ts: string })
  | ({
      frame_id: FrameId
      iteration: number
      max_iterations: number
      node_path: NodePath
      outcome: LoopIterationOutcome
      user_id: string | null
    } & { kind: "loop_iteration_finished"; ts: string })
  | ({
      detail: string | null
      frame_id: FrameId
      node_path: NodePath
      provider: ProviderKind
      tool: string
      user_id: string | null
    } & { kind: "provider_tool_use"; ts: string })
  | ({
      frame_id: FrameId
      message: string
      node_path: NodePath
      provider: ProviderKind
      user_id: string | null
    } & { kind: "provider_status"; ts: string })
  | ({
      frame_id: FrameId
      message: string
      node_path: NodePath
      provider: ProviderKind
      user_id: string | null
    } & { kind: "provider_error"; ts: string })
  | ({
      attempt: number
      duration_ms: number | null
      exit_code: number | null
      frame_id: FrameId
      node_path: NodePath
      result: unknown
      status: NodeStatus
      stderr: string | null
      stderr_path: string | null
      stderr_preview: string
      stdout: unknown
      stdout_path: string | null
      stdout_preview: string
      user_id: string | null
    } & { kind: "node_finished"; ts: string })
  | ({
      reason: RunReason
      status: Exclude<RunStatus, "running">
    } & { kind: "run_finished"; ts: string })
  | ({
      message: string
      reason: RunReason
    } & { kind: "run_failed"; ts: string })

export type RecordedRunEventInput = RecordedRunEvent extends infer Event
  ? Event extends { ts: string }
    ? Omit<Event, "ts">
    : never
  : never
