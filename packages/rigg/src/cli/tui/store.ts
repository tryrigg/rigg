import type { RunEvent } from "../../session/event"
import type { RunSnapshot } from "../../session/schema"
import { applyRunEvent, createTerminalUiState, type BarrierApprovalMode, type TerminalUiState } from "../state"

export type StoreSnapshot = {
  state: TerminalUiState
  timerTick: number
}

export type Store = {
  getSnapshot: () => StoreSnapshot
  subscribe: (listener: () => void) => () => void
  dispatch: (event: RunEvent) => void
  replaceSnapshot: (snapshot: RunSnapshot | null) => void
  startTimer: () => void
  stopTimer: () => void
}

export function createStore(options: { barrierMode?: BarrierApprovalMode } = {}): Store {
  const uiState = createTerminalUiState(options.barrierMode)

  let timerTick = 0
  let timerInterval: ReturnType<typeof setInterval> | null = null
  const listeners = new Set<() => void>()

  let snapshot: StoreSnapshot = {
    state: { ...uiState },
    timerTick: 0,
  }

  function buildSnapshot(): StoreSnapshot {
    return {
      state: { ...uiState },
      timerTick,
    }
  }

  function notify(): void {
    snapshot = buildSnapshot()
    for (const listener of listeners) {
      listener()
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispatch: (event) => {
      applyRunEvent(uiState, event)
      notify()
    },
    replaceSnapshot: (snapshot) => {
      uiState.snapshot = snapshot
      notify()
    },
    startTimer: () => {
      if (timerInterval !== null) {
        return
      }
      timerInterval = setInterval(() => {
        timerTick++
        notify()
      }, 1000)
    },
    stopTimer: () => {
      if (timerInterval !== null) {
        clearInterval(timerInterval)
        timerInterval = null
      }
    },
  }
}
