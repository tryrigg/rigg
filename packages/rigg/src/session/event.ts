import type { ClaudeProviderEvent } from "../claude/event"
import type { CodexProviderEvent } from "../codex/event"
import type { CursorProviderEvent } from "../cursor/event"
import type { InteractionResolution } from "./interaction"
import type { NodeSnapshot, PendingInteraction, RunSnapshot, StepBarrier } from "./schema"

export type StreamKind = "stdout" | "stderr"
export type ProviderEvent = ClaudeProviderEvent | CodexProviderEvent | CursorProviderEvent
export type PreviousAttempt = {
  attempt: number
  exit_code: number | null
  message: string
  stderr: string | null
}

export type RunEvent =
  | {
      kind: "run_started"
      snapshot: RunSnapshot
    }
  | {
      kind: "node_started"
      node: NodeSnapshot
      snapshot: RunSnapshot
    }
  | {
      kind: "node_completed"
      node: NodeSnapshot
      snapshot: RunSnapshot
    }
  | {
      kind: "node_skipped"
      node: NodeSnapshot
      reason: string
      snapshot: RunSnapshot
    }
  | {
      attempt?: number
      chunk: string
      kind: "step_output"
      node_path: string
      stream: StreamKind
      user_id: string | null
    }
  | {
      attempt: number
      delay_ms: number
      kind: "node_retrying"
      max_attempts: number
      next_attempt: number
      node_path: string
      previous_attempts: PreviousAttempt[]
      user_id: string | null
    }
  | {
      attempt?: number
      event: ProviderEvent
      kind: "provider_event"
      node_path: string
      user_id: string | null
    }
  | {
      barrier: StepBarrier
      kind: "barrier_reached"
      snapshot: RunSnapshot
    }
  | {
      action: "abort" | "continue"
      barrier_id: string
      kind: "barrier_resolved"
      snapshot: RunSnapshot
    }
  | {
      interaction: PendingInteraction
      kind: "interaction_requested"
      snapshot: RunSnapshot
    }
  | {
      interaction_id: string
      kind: "interaction_resolved"
      resolution: InteractionResolution
      snapshot: RunSnapshot
    }
  | {
      kind: "run_finished"
      snapshot: RunSnapshot
    }

export type StepBarrierResolution = {
  action: "abort" | "continue"
  kind: "step_barrier"
}

export type RunControlRequest =
  | {
      barrier: StepBarrier
      kind: "step_barrier"
      signal: AbortSignal
      snapshot: RunSnapshot
    }
  | {
      interaction: PendingInteraction
      kind: "interaction"
      signal: AbortSignal
      snapshot: RunSnapshot
    }

export type RunControlResolution = InteractionResolution | StepBarrierResolution
export type RunControlHandler = (request: RunControlRequest) => Promise<RunControlResolution> | RunControlResolution
