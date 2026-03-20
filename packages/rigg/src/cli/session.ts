import React from "react"
import { render } from "ink"

import type { InteractionResolution } from "../session/interaction"
import type { WorkflowProject } from "../project"
import type { WorkflowDocument } from "../workflow/schema"
import type { RunControlHandler, RunEvent } from "../session/event"
import { App } from "./tui/app"
import { createStore } from "./tui/store"
import { addSynthetic, createRegistry, removeSynthetic, resolveImmediate } from "./control"
import { type ApprovalMode } from "./state"

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
