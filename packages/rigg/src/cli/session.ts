import React from "react"
import { render } from "ink"

import {
  findDecision,
  type ApprovalRequest,
  type InteractionResolution,
  type UserInputQuestion,
} from "../session/interaction"
import type { WorkflowProject } from "../project"
import type { WorkflowDocument } from "../workflow/schema"
import type { RunControlHandler, RunControlRequest, RunEvent } from "../session/event"
import { App } from "./tui/app"
import { createStore } from "./tui/store"
import { addSynthetic, createRegistry, removeSynthetic, resolveImmediate } from "./control"
import { type ApprovalMode } from "./state"
import { assertUnreachable } from "../util/assert"

export type RunSession = {
  close: () => void
  emit: (event: RunEvent) => void
  handle: RunControlHandler
}

export type InterruptHandler = () => void

type InteractiveTerminal = {
  stderr: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
}

type InkRenderFunction = typeof render

export function createNonInteractive(): RunSession {
  return {
    close: () => {},
    emit: () => {},
    handle: async (request) => {
      if (request.kind === "step_barrier") {
        return { action: "continue", kind: "step_barrier" }
      }

      throw new Error(
        `workflow requires operator interaction (${request.interaction.kind}), but rigg run is not attached to an interactive terminal`,
      )
    },
  }
}

function selectHeadlessApprovalDecision(request: ApprovalRequest): string {
  const deny = findDecision(request, "deny")
  if (deny !== undefined) {
    return deny.value
  }

  const cancel = findDecision(request, "cancel")
  if (cancel !== undefined) {
    return cancel.value
  }

  const fallback = request.decisions.find((decision) => decision.intent !== "approve")
  if (fallback !== undefined) {
    return fallback.value
  }

  throw new Error("headless approval requires an explicit non-approve decision")
}

function answersFromInitialValues(questions: UserInputQuestion[]): Record<string, { answers: string[] }> {
  const answers: Record<string, { answers: string[] }> = {}

  for (const question of questions) {
    if (question.initialValue === undefined && question.allowEmpty === false) {
      throw new Error(`cannot answer required prompt non-interactively (${question.id})`)
    }

    answers[question.id] = {
      answers: question.initialValue === undefined ? [] : [question.initialValue],
    }
  }

  return answers
}

function resolveHeadlessInteraction(
  interaction: Extract<RunControlRequest, { kind: "interaction" }>["interaction"],
): InteractionResolution {
  if (interaction.kind === "approval") {
    if (interaction.request.kind !== "approval") {
      throw new Error(`headless interaction kind mismatch: ${interaction.kind}/${interaction.request.kind}`)
    }
    return {
      decision: selectHeadlessApprovalDecision(interaction.request),
      kind: "approval",
    }
  }

  if (interaction.kind === "elicitation") {
    if (interaction.request.kind !== "elicitation") {
      throw new Error(`headless interaction kind mismatch: ${interaction.kind}/${interaction.request.kind}`)
    }
    return { action: "decline", kind: "elicitation" }
  }

  if (interaction.kind === "user_input") {
    if (interaction.request.kind !== "user_input") {
      throw new Error(`headless interaction kind mismatch: ${interaction.kind}/${interaction.request.kind}`)
    }
    return {
      answers: answersFromInitialValues(interaction.request.questions),
      kind: "user_input",
    }
  }

  return assertUnreachable(interaction.kind, "Unexpected interaction kind in headless mode")
}

export function createHeadless(): RunSession {
  return {
    close: () => {},
    emit: () => {},
    handle: async (request) => {
      if (request.kind === "step_barrier") {
        return { action: "continue", kind: "step_barrier" }
      }

      return resolveHeadlessInteraction(request.interaction)
    },
  }
}

export function createRenderOptions(terminal: InteractiveTerminal): NonNullable<Parameters<InkRenderFunction>[1]> {
  return {
    exitOnCtrlC: false,
    stderr: terminal.stderr,
    stdin: terminal.stdin,
    stdout: terminal.stderr,
  }
}

export function createInkSession(options: {
  barrierMode: ApprovalMode
  interrupt: InterruptHandler
  project?: WorkflowProject | undefined
  renderApp?: InkRenderFunction
  terminal?: InteractiveTerminal
  workflow: WorkflowDocument
}): RunSession {
  const store = createStore({ barrierMode: options.barrierMode })
  const controlResolvers = createRegistry()
  const terminal = options.terminal ?? {
    stderr: process.stderr,
    stdin: process.stdin,
  }
  const renderApp = options.renderApp ?? render
  const inkInstance = renderApp(
    React.createElement(App, {
      barrierMode: options.barrierMode,
      onInterrupt: options.interrupt,
      onResolveBarrier: (barrierId: string, action: "abort" | "continue") =>
        controlResolvers.resolveBarrier(barrierId, action),
      onResolveInteraction: (interactionId: string, resolution: InteractionResolution) =>
        controlResolvers.resolveInteraction(interactionId, resolution),
      project: options.project,
      store,
      workflow: options.workflow,
    }),
    createRenderOptions(terminal),
  )

  return {
    close: () => {
      controlResolvers.clear("run session closed")
      store.stopTimer()
      inkInstance.unmount()
    },
    emit: (event) => {
      store.dispatch(event)
      if (event.kind === "run_started") {
        store.startTimer()
      }
      if (event.kind === "run_finished") {
        store.stopTimer()
      }
    },
    handle: (request) => {
      if (request.kind === "step_barrier" && options.barrierMode === "auto_continue") {
        return { action: "continue", kind: "step_barrier" }
      }

      const immediateResolution = resolveImmediate(request)
      if (immediateResolution !== null) {
        return immediateResolution
      }

      if (request.kind !== "interaction" || store.getSnapshot().state.snapshot !== null) {
        return controlResolvers.register(request)
      }

      store.replaceSnapshot(addSynthetic(request.snapshot, request))

      return Promise.resolve(controlResolvers.register(request)).then(
        (resolution) => {
          const currentSnapshot = store.getSnapshot().state.snapshot
          if (currentSnapshot !== null) {
            store.replaceSnapshot(removeSynthetic(currentSnapshot, request.interaction.interaction_id))
          }
          return resolution
        },
        (error) => {
          const currentSnapshot = store.getSnapshot().state.snapshot
          if (currentSnapshot !== null) {
            store.replaceSnapshot(removeSynthetic(currentSnapshot, request.interaction.interaction_id))
          }
          throw error
        },
      )
    },
  }
}
