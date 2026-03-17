import type { RunEvent } from "../../run/progress"
import type { RunSnapshot } from "../../run/schema"
import { applyRunEvent, createTerminalUiState, type TerminalUiState } from "../run"

export type TuiStoreSnapshot = {
  state: TerminalUiState
  timerTick: number
}

export type TuiStore = {
  getSnapshot: () => TuiStoreSnapshot
  subscribe: (listener: () => void) => () => void
  dispatch: (event: RunEvent) => void
  replaceSnapshot: (snapshot: RunSnapshot | null) => void
  startTimer: () => void
  stopTimer: () => void
}

export function createTuiStore(): TuiStore {
  const uiState = createTerminalUiState()

  let timerTick = 0
  let timerInterval: ReturnType<typeof setInterval> | null = null
  const listeners = new Set<() => void>()

  let snapshot: TuiStoreSnapshot = {
    state: { ...uiState },
    timerTick: 0,
  }

  function buildSnapshot(): TuiStoreSnapshot {
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
