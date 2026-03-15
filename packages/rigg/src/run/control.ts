import { v7 as uuidv7 } from "uuid"

import type { NodePath } from "../compile/schema"
import type { CodexInteractionRequest, CodexInteractionResolution } from "../codex/interaction"
import { RunAbortedError } from "./error"
import { currentNodeSnapshot } from "./node"
import type { RunControlHandler, RunControlResolution, RunEvent } from "./progress"
import type {
  BarrierReason,
  CompletedNodeSummary,
  FrontierNode,
  InteractionKind,
  PendingInteraction,
  RunSnapshot,
} from "./schema"
import { setActiveBarrier, setActiveInteraction, setRunPhase, upsertNodeSnapshot } from "./state"

export type ActionContext = {
  nodePath: NodePath
  userId: string | null
}

export type ControlBroker = {
  enqueue: <T>(priority: number, task: () => Promise<T>) => Promise<T>
}

type ControlEnvironment = {
  controlBroker: ControlBroker
  controlHandler?: RunControlHandler | undefined
  emitEvent: (event: RunEvent) => void
  runState: RunSnapshot
}

export function createControlBroker(): ControlBroker {
  const queue: Array<{
    priority: number
    reject: (error: unknown) => void
    resolve: (value: unknown) => void
    sequence: number
    task: () => Promise<unknown>
  }> = []
  let nextSequence = 0
  let processing = false

  async function pump(): Promise<void> {
    if (processing) {
      return
    }

    processing = true
    try {
      while (queue.length > 0) {
        queue.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence)
        const entry = queue.shift()
        if (entry === undefined) {
          continue
        }

        try {
          entry.resolve(await entry.task())
        } catch (error) {
          entry.reject(error)
        }
      }
    } finally {
      processing = false
    }
  }

  return {
    enqueue: async <T>(priority: number, task: () => Promise<T>): Promise<T> =>
      await new Promise<T>((resolve, reject) => {
        queue.push({
          priority,
          reject,
          resolve: (value) => resolve(value as T),
          sequence: nextSequence++,
          task,
        })
        void pump()
      }),
  }
}

export async function waitForBarrier(
  environment: ControlEnvironment,
  input: {
    completed: CompletedNodeSummary | null
    frameId: string
    next: FrontierNode[]
    reason: BarrierReason
  },
): Promise<void> {
  await environment.controlBroker.enqueue(0, async () => {
    const barrier = {
      barrier_id: uuidv7(),
      completed: input.completed,
      created_at: new Date().toISOString(),
      frame_id: input.frameId,
      next: input.next,
      reason: input.reason,
    }
    setActiveBarrier(environment.runState, barrier)
    setRunPhase(environment.runState, "waiting_for_barrier")
    environment.emitEvent({
      barrier,
      kind: "barrier_reached",
      snapshot: environment.runState,
    })

    const resolution = await resolveControl(environment.controlHandler, {
      barrier,
      kind: "step_barrier",
      snapshot: environment.runState,
    })
    if (resolution.kind !== "step_barrier") {
      throw new Error(`control handler returned ${resolution.kind} for step_barrier`)
    }

    setActiveBarrier(environment.runState, null)
    setRunPhase(environment.runState, "running")
    environment.emitEvent({
      action: resolution.action,
      barrier_id: barrier.barrier_id,
      kind: "barrier_resolved",
      snapshot: environment.runState,
    })

    if (resolution.action === "abort") {
      throw new RunAbortedError()
    }
  })
}

export async function resolveInteraction(
  environment: ControlEnvironment,
  request: CodexInteractionRequest,
  actionContext: ActionContext,
): Promise<CodexInteractionResolution> {
  if (environment.controlHandler === undefined) {
    throw new Error(`codex app-server requested ${request.kind}, but no control handler is configured`)
  }

  return await environment.controlBroker.enqueue(10, async () => {
    const nodeSnapshot = currentNodeSnapshot(environment.runState, actionContext.nodePath)
    const interaction: PendingInteraction = {
      created_at: new Date().toISOString(),
      interaction_id: request.requestId,
      kind: mapInteractionKind(request.kind),
      node_path: actionContext.nodePath,
      request,
      user_id: actionContext.userId,
    }

    if (nodeSnapshot !== undefined) {
      nodeSnapshot.status = "waiting_for_interaction"
      nodeSnapshot.waiting_for = interaction.kind
      upsertNodeSnapshot(environment.runState, nodeSnapshot)
    }

    setActiveInteraction(environment.runState, interaction)
    setRunPhase(environment.runState, phaseForInteraction(interaction.kind))
    environment.emitEvent({
      interaction,
      kind: "interaction_requested",
      snapshot: environment.runState,
    })

    const resolution = await resolveControl(environment.controlHandler, {
      interaction,
      kind: "interaction",
      snapshot: environment.runState,
    })
    if (resolution.kind !== request.kind) {
      throw new Error(`control handler returned ${resolution.kind} for ${request.kind}`)
    }

    if (nodeSnapshot !== undefined) {
      nodeSnapshot.status = "running"
      nodeSnapshot.waiting_for = null
      upsertNodeSnapshot(environment.runState, nodeSnapshot)
    }

    setActiveInteraction(environment.runState, null)
    setRunPhase(environment.runState, "running")
    environment.emitEvent({
      interaction_id: interaction.interaction_id,
      kind: "interaction_resolved",
      resolution,
      snapshot: environment.runState,
    })

    return resolution
  })
}

async function resolveControl(
  controlHandler: RunControlHandler | undefined,
  request: Parameters<RunControlHandler>[0],
): Promise<RunControlResolution> {
  if (request.kind === "step_barrier" && controlHandler === undefined) {
    return { action: "continue", kind: "step_barrier" }
  }
  if (controlHandler === undefined) {
    throw new Error("control handler is not configured")
  }

  return await controlHandler(request)
}

function phaseForInteraction(
  kind: InteractionKind,
): "waiting_for_approval" | "waiting_for_interaction" | "waiting_for_question" {
  switch (kind) {
    case "approval":
      return "waiting_for_approval"
    case "user_input":
      return "waiting_for_question"
    case "elicitation":
      return "waiting_for_interaction"
  }
}

function mapInteractionKind(kind: CodexInteractionRequest["kind"]): InteractionKind {
  switch (kind) {
    case "approval":
      return "approval"
    case "user_input":
      return "user_input"
    case "elicitation":
      return "elicitation"
  }
}
