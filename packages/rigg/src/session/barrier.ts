import { v7 as uuidv7 } from "uuid"

import type { NodePath } from "../workflow/id"
import type { InteractionRequest, InteractionResolution } from "./interaction"
import { onAbort } from "../util/abort"
import { isAbortError } from "../util/error"
import { timestampNow } from "../util/time"
import { isInterrupt, runAborted, interrupt } from "./error"
import { currentNodeSnapshot } from "./node"
import type { RunControlHandler, RunControlResolution, RunEvent } from "./event"
import { snapControl } from "./snap"
import type { BarrierReason, CompletedNodeSummary, FrontierNode, PendingInteraction, RunSnapshot } from "./schema"
import { setBarrier, setInteraction, upsertNode } from "./state"

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
  run: (signal: AbortSignal) => Promise<void>
  sequence: number
  started: boolean
}

const CONTROL_ABORTED = Symbol("control-aborted")

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
          await entry.run(entry.controller.signal)
        } catch (error) {
          entry.reject(error)
          if (!isInterrupt(error)) {
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
        let disposeAbort = () => {}

        const entry: ControlQueueEntry = {
          controller,
          dispose: () => disposeAbort(),
          priority: input.priority,
          reject,
          run: async (signal) => {
            resolve(await input.run(signal))
          },
          sequence: nextSequence++,
          started: false,
        }

        insertSorted(entry)
        disposeAbort = onAbort(input.signal, () => {
          controller.abort(input.signal?.reason)
          if (!entry.started) {
            removeEntry(entry)
            entry.dispose()
            reject(createControlInterruptedError(input.signal?.reason))
          }
        })
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
      setBarrier(environment.runState, barrier)
      environment.emitEvent({
        barrier,
        kind: "barrier_reached",
        snapshot: environment.runState,
      })

      let resolution: RunControlResolution
      try {
        resolution = await resolveControl(
          environment.controlHandler,
          snapControl({
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
          setBarrier(environment.runState, null)
        }
      }

      environment.emitEvent({
        action: resolution.action,
        barrier_id: barrier.barrier_id,
        kind: "barrier_resolved",
        snapshot: environment.runState,
      })

      if (resolution.action === "abort") {
        throw runAborted()
      }
    },
    signal: input.signal,
  })
}

export async function resolveInteraction(
  environment: ControlEnvironment,
  request: InteractionRequest,
  actionContext: ActionContext,
  signal?: AbortSignal | undefined,
): Promise<InteractionResolution> {
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
        upsertNode(environment.runState, nodeSnapshot)
      }

      setInteraction(environment.runState, interaction)
      environment.emitEvent({
        interaction,
        kind: "interaction_requested",
        snapshot: environment.runState,
      })

      let resolution: RunControlResolution
      try {
        resolution = await resolveControl(
          environment.controlHandler,
          snapControl({
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
          upsertNode(environment.runState, nodeSnapshot)
        }
        if (environment.runState.active_interaction?.interaction_id === interaction.interaction_id) {
          setInteraction(environment.runState, null)
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
  const abortRace = createControlAbortRace(request.signal)

  try {
    const resolution = await Promise.race([Promise.resolve(controlHandler(request)), abortRace.promise])
    throwIfControlAborted(request.signal)
    return resolution
  } catch (error) {
    if (error === CONTROL_ABORTED) {
      throw createControlInterruptedError(request.signal.reason)
    }
    if (request.signal.aborted && isAbortError(error)) {
      throw createControlInterruptedError(request.signal.reason ?? error)
    }
    throw error
  } finally {
    abortRace.dispose()
  }
}

function throwIfControlAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createControlInterruptedError(signal.reason)
  }
}

function createControlAbortRace(signal: AbortSignal): { dispose: () => void; promise: Promise<never> } {
  let dispose = () => {}
  const promise = new Promise<never>((_, reject) => {
    dispose = onAbort(signal, () => reject(CONTROL_ABORTED))
  })

  return { dispose, promise }
}

function createControlInterruptedError(cause: unknown) {
  return interrupt("control interrupted", { cause })
}
