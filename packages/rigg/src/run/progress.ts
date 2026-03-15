import type { CodexProviderEvent } from "../codex/event"
import type { CodexInteractionResolution } from "../codex/interaction"
import type { NodeSnapshot, PendingInteraction, RunSnapshot, StepBarrier } from "./schema"

export type StreamKind = "stdout" | "stderr"

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
      chunk: string
      kind: "step_output"
      node_path: string
      stream: StreamKind
      user_id: string | null
    }
  | {
      event: CodexProviderEvent
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
      resolution: CodexInteractionResolution
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
      snapshot: RunSnapshot
    }
  | {
      interaction: PendingInteraction
      kind: "interaction"
      snapshot: RunSnapshot
    }

export type RunControlResolution = CodexInteractionResolution | StepBarrierResolution
export type RunControlHandler = (request: RunControlRequest) => Promise<RunControlResolution> | RunControlResolution
