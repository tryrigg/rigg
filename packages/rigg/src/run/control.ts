import { v7 as uuidv7 } from "uuid"

import type { NodePath } from "../compile/schema"
import type { CodexInteractionRequest, CodexInteractionResolution } from "../codex/interaction"
import { isAbortError } from "../util/error"
import { timestampNow } from "../util/time"
import { isStepInterrupted, RunAbortedError, StepInterruptedError } from "./error"
import { currentNodeSnapshot } from "./node"
import type { RunControlHandler, RunControlResolution, RunEvent } from "./progress"
import { snapshotRunControlRequest } from "./snapshot"
import type { BarrierReason, CompletedNodeSummary, FrontierNode, PendingInteraction, RunSnapshot } from "./schema"
import { setActiveBarrier, setActiveInteraction, upsertNodeSnapshot } from "./state"

export type ActionContext = {
  nodePath: NodePath
  userId: string | null
}

export type ControlBroker = {
  enqueue: <T>(input: {
    priority: number
    run: (signal: AbortSignal) => Promise<T>
    signal?: AbortSignal | undefined
  }) => Promise<T>
}

type ControlEnvironment = {
  controlBroker: ControlBroker
  controlHandler: RunControlHandler
  emitEvent: (event: RunEvent) => void
  runState: RunSnapshot
}

type ControlQueueEntry = {
  controller: AbortController
  dispose: () => void
  priority: number
  reject: (error: unknown) => void
  resolve: (value: unknown) => void
  run: (signal: AbortSignal) => Promise<unknown>
  sequence: number
  started: boolean
}

export function createControlBroker(): ControlBroker {
  const queue: ControlQueueEntry[] = []
  let nextSequence = 0
  let processing = false

  function insertSorted(entry: ControlQueueEntry): void {
    let lo = 0
    let hi = queue.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      const current = queue[mid]
      if (current === undefined) {
        lo = mid + 1
        continue
      }

      const cmp = current.priority - entry.priority || entry.sequence - current.sequence
      if (cmp < 0) {
        hi = mid
      } else {
        lo = mid + 1
      }
    }
    queue.splice(lo, 0, entry)
  }

  function removeEntry(target: ControlQueueEntry): void {
    const index = queue.indexOf(target)
    if (index >= 0) {
      queue.splice(index, 1)
    }
  }

  function failQueued(error: unknown): void {
    const queued = queue.splice(0, queue.length)
    for (const entry of queued) {
      entry.dispose()
      entry.reject(error)
    }
  }

  async function pump(): Promise<void> {
    if (processing) {
      return
    }

    processing = true
    try {
      while (queue.length > 0) {
        const entry = queue.shift()
        if (entry === undefined) {
          continue
        }

        entry.started = true
        try {
          entry.resolve(await entry.run(entry.controller.signal))
        } catch (error) {
          entry.reject(error)
          if (!isStepInterrupted(error)) {
            failQueued(error)
            return
          }
        } finally {
          entry.dispose()
        }
      }
    } finally {
      processing = false
      if (queue.length > 0) {
        void pump()
      }
    }
  }

  return {
    enqueue: async <T>(input: {
      priority: number
      run: (signal: AbortSignal) => Promise<T>
      signal?: AbortSignal | undefined
    }): Promise<T> => {
      return await new Promise<T>((resolve, reject) => {
        const controller = new AbortController()
        const abortListener = () => {
          controller.abort(input.signal?.reason)
          if (!entry.started) {
            removeEntry(entry)
            entry.dispose()
            reject(createControlInterruptedError(input.signal?.reason))
          }
        }

        const entry: ControlQueueEntry = {
          controller,
          dispose: () => input.signal?.removeEventListener("abort", abortListener),
          priority: input.priority,
          reject,
          resolve: (value) => resolve(value as T),
          run: async (signal) => await input.run(signal),
          sequence: nextSequence++,
          started: false,
        }

        if (input.signal?.aborted) {
          controller.abort(input.signal.reason)
          entry.dispose()
          reject(createControlInterruptedError(input.signal.reason))
          return
        }

        input.signal?.addEventListener("abort", abortListener, { once: true })
        insertSorted(entry)
        void pump()
      })
    },
  }
}

export async function waitForBarrier(
  environment: ControlEnvironment,
  input: {
    completed: CompletedNodeSummary | null
    frameId: string
    next: FrontierNode[]
    reason: BarrierReason
    signal?: AbortSignal | undefined
  },
): Promise<void> {
  const barrier = {
    barrier_id: uuidv7(),
    completed: input.completed,
    created_at: timestampNow(),
    frame_id: input.frameId,
    next: input.next,
    reason: input.reason,
  }

  await environment.controlBroker.enqueue({
    priority: 0,
    run: async (signal) => {
      setActiveBarrier(environment.runState, barrier)
      environment.emitEvent({
        barrier,
        kind: "barrier_reached",
        snapshot: environment.runState,
      })

      let resolution: RunControlResolution
      try {
        resolution = await resolveControl(
          environment.controlHandler,
          snapshotRunControlRequest({
            barrier,
            kind: "step_barrier",
            signal,
            snapshot: environment.runState,
          }),
        )
        if (resolution.kind !== "step_barrier") {
          throw new Error(`control handler returned ${resolution.kind} for step_barrier`)
        }
      } finally {
        if (environment.runState.active_barrier?.barrier_id === barrier.barrier_id) {
          setActiveBarrier(environment.runState, null)
        }
      }

      environment.emitEvent({
        action: resolution.action,
        barrier_id: barrier.barrier_id,
        kind: "barrier_resolved",
        snapshot: environment.runState,
      })

      if (resolution.action === "abort") {
        throw new RunAbortedError()
      }
    },
    signal: input.signal,
  })
}

export async function resolveInteraction(
  environment: ControlEnvironment,
  request: CodexInteractionRequest,
  actionContext: ActionContext,
  signal?: AbortSignal | undefined,
): Promise<CodexInteractionResolution> {
  const interaction: PendingInteraction = {
    created_at: timestampNow(),
    interaction_id: request.requestId,
    kind: request.kind,
    node_path: actionContext.nodePath,
    request,
    user_id: actionContext.userId,
  }

  return await environment.controlBroker.enqueue({
    priority: 10,
    run: async (controlSignal) => {
      const nodeSnapshot = currentNodeSnapshot(environment.runState, actionContext.nodePath)

      if (nodeSnapshot !== undefined) {
        nodeSnapshot.status = "waiting_for_interaction"
        nodeSnapshot.waiting_for = interaction.kind
        upsertNodeSnapshot(environment.runState, nodeSnapshot)
      }

      setActiveInteraction(environment.runState, interaction)
      environment.emitEvent({
        interaction,
        kind: "interaction_requested",
        snapshot: environment.runState,
      })

      let resolution: RunControlResolution
      try {
        resolution = await resolveControl(
          environment.controlHandler,
          snapshotRunControlRequest({
            interaction,
            kind: "interaction",
            signal: controlSignal,
            snapshot: environment.runState,
          }),
        )
        if (resolution.kind !== request.kind) {
          throw new Error(`control handler returned ${resolution.kind} for ${request.kind}`)
        }
      } finally {
        if (nodeSnapshot !== undefined) {
          nodeSnapshot.status = "running"
          nodeSnapshot.waiting_for = null
          upsertNodeSnapshot(environment.runState, nodeSnapshot)
        }
        if (environment.runState.active_interaction?.interaction_id === interaction.interaction_id) {
          setActiveInteraction(environment.runState, null)
        }
      }
      environment.emitEvent({
        interaction_id: interaction.interaction_id,
        kind: "interaction_resolved",
        resolution,
        snapshot: environment.runState,
      })

      return resolution
    },
    signal,
  })
}

async function resolveControl(
  controlHandler: RunControlHandler,
  request: Parameters<RunControlHandler>[0],
): Promise<RunControlResolution> {
  throwIfControlAborted(request.signal)

  try {
    const resolution = await controlHandler(request)
    throwIfControlAborted(request.signal)
    return resolution
  } catch (error) {
    if (request.signal.aborted && isAbortError(error)) {
      throw createControlInterruptedError(request.signal.reason ?? error)
    }
    throw error
  }
}

function throwIfControlAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createControlInterruptedError(signal.reason)
  }
}

function createControlInterruptedError(cause: unknown): StepInterruptedError {
  return new StepInterruptedError("control interrupted", { cause })
}
