import type { InteractionResolution } from "../session/interaction"
import type { RunControlRequest, RunControlResolution } from "../session/event"
import type { RunSnapshot } from "../session/schema"
import { setInteraction } from "../session/state"
import { onAbort } from "../util/abort"
import { createAbortError } from "../util/error"

type ResolverEntry =
  | {
      dispose: () => void
      kind: "interaction"
      reject: (error: unknown) => void
      resolve: (resolution: InteractionResolution) => void
    }
  | {
      dispose: () => void
      kind: "step_barrier"
      reject: (error: unknown) => void
      resolve: (resolution: Extract<RunControlResolution, { kind: "step_barrier" }>) => void
    }

export type ControlResolverRegistry = {
  clear: (reason?: unknown) => void
  register: (request: RunControlRequest) => Promise<RunControlResolution>
  resolveBarrier: (barrierId: string, action: "abort" | "continue") => void
  resolveInteraction: (interactionId: string, resolution: InteractionResolution) => void
}

export function resolveImmediateControlRequest(request: RunControlRequest): RunControlResolution | null {
  if (request.kind === "step_barrier") {
    return null
  }

  const interaction = request.interaction.request
  if (interaction.kind === "user_input" && interaction.questions.length === 0) {
    return {
      answers: {},
      kind: "user_input",
    }
  }

  return null
}

export function withSyntheticActiveInteraction(
  snapshot: RunSnapshot,
  request: RunControlRequest & { kind: "interaction" },
): RunSnapshot {
  const next = structuredClone(snapshot)
  setInteraction(next, structuredClone(request.interaction))
  return next
}

export function withoutSyntheticActiveInteraction(snapshot: RunSnapshot, interactionId: string): RunSnapshot {
  const next = structuredClone(snapshot)
  if (next.active_interaction?.interaction_id === interactionId) {
    setInteraction(next, null)
  }
  return next
}

export function createControlResolverRegistry(): ControlResolverRegistry {
  const entries = new Map<string, ResolverEntry>()

  function release(id: string): ResolverEntry | undefined {
    const entry = entries.get(id)
    if (entry === undefined) {
      return undefined
    }
    entries.delete(id)
    entry.dispose()
    return entry
  }

  return {
    clear: (reason) => {
      const error = createAbortError(reason ?? "run session closed")
      for (const [id, entry] of entries) {
        entries.delete(id)
        entry.dispose()
        entry.reject(error)
      }
    },
    register: (request) => {
      const id = request.kind === "step_barrier" ? request.barrier.barrier_id : request.interaction.interaction_id

      return new Promise<RunControlResolution>((resolve, reject) => {
        let disposeAbort = () => {}
        const onAbortRequest = () => {
          const entry = release(id)
          entry?.reject(createAbortError(request.signal.reason))
        }

        const entry: ResolverEntry =
          request.kind === "step_barrier"
            ? {
                dispose: () => disposeAbort(),
                kind: "step_barrier",
                reject,
                resolve: (resolution) => resolve(resolution),
              }
            : {
                dispose: () => disposeAbort(),
                kind: "interaction",
                reject,
                resolve: (resolution) => resolve(resolution),
              }

        entries.set(id, entry)
        disposeAbort = onAbort(request.signal, onAbortRequest)
      })
    },
    resolveBarrier: (barrierId, action) => {
      const entry = release(barrierId)
      if (entry?.kind !== "step_barrier") {
        return
      }
      entry.resolve({ action, kind: "step_barrier" })
    },
    resolveInteraction: (interactionId, resolution) => {
      const entry = release(interactionId)
      if (entry?.kind !== "interaction") {
        return
      }
      entry.resolve(resolution)
    },
  }
}
