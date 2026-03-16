import type { CodexProviderEvent } from "../codex/event"
import type { RunControlRequest, RunEvent } from "./progress"
import type { NodeSnapshot, PendingInteraction, RunSnapshot, StepBarrier } from "./schema"

export function snapshotRunEvent(event: RunEvent): RunEvent {
  switch (event.kind) {
    case "run_started":
    case "run_finished":
      return {
        kind: event.kind,
        snapshot: cloneValue(event.snapshot),
      }
    case "node_started":
    case "node_completed":
      return {
        kind: event.kind,
        node: cloneValue(event.node),
        snapshot: cloneValue(event.snapshot),
      }
    case "node_skipped":
      return {
        kind: event.kind,
        node: cloneValue(event.node),
        reason: event.reason,
        snapshot: cloneValue(event.snapshot),
      }
    case "step_output":
      return event
    case "provider_event":
      return {
        ...event,
        event: cloneValue(event.event),
      }
    case "barrier_reached":
      return {
        barrier: cloneValue(event.barrier),
        kind: "barrier_reached",
        snapshot: cloneValue(event.snapshot),
      }
    case "barrier_resolved":
      return {
        action: event.action,
        barrier_id: event.barrier_id,
        kind: "barrier_resolved",
        snapshot: cloneValue(event.snapshot),
      }
    case "interaction_requested":
      return {
        interaction: cloneValue(event.interaction),
        kind: "interaction_requested",
        snapshot: cloneValue(event.snapshot),
      }
    case "interaction_resolved":
      return {
        interaction_id: event.interaction_id,
        kind: "interaction_resolved",
        resolution: cloneValue(event.resolution),
        snapshot: cloneValue(event.snapshot),
      }
  }
}

export function snapshotRunControlRequest(request: RunControlRequest): RunControlRequest {
  switch (request.kind) {
    case "step_barrier":
      return {
        barrier: cloneValue(request.barrier),
        kind: "step_barrier",
        signal: request.signal,
        snapshot: cloneValue(request.snapshot),
      }
    case "interaction":
      return {
        interaction: cloneValue(request.interaction),
        kind: "interaction",
        signal: request.signal,
        snapshot: cloneValue(request.snapshot),
      }
  }
}

export function cloneRunSnapshot(snapshot: RunSnapshot): RunSnapshot {
  return cloneValue(snapshot)
}

export function cloneNodeSnapshot(node: NodeSnapshot): NodeSnapshot {
  return cloneValue(node)
}

export function cloneStepBarrier(barrier: StepBarrier): StepBarrier {
  return cloneValue(barrier)
}

export function clonePendingInteraction(interaction: PendingInteraction): PendingInteraction {
  return cloneValue(interaction)
}

export function cloneProviderEvent(event: CodexProviderEvent): CodexProviderEvent {
  return cloneValue(event)
}

function cloneValue<T>(value: T): T {
  return structuredClone(value)
}
