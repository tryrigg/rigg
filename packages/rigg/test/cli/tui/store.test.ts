import { afterEach, describe, expect, test } from "bun:test"

import { createTuiStore } from "../../../src/cli/tui/store"
import { runSnapshot } from "../../fixture/builders"

describe("TuiStore", () => {
  let timerCleanup: (() => void) | null = null

  afterEach(() => {
    timerCleanup?.()
    timerCleanup = null
  })

  test("dispatch updates state snapshot", () => {
    const store = createTuiStore()
    const snapshot = runSnapshot()
    store.dispatch({ kind: "run_started", snapshot })
    expect(store.getSnapshot().state.snapshot).toBe(snapshot)
  })

  test("subscribe notifies on dispatch", () => {
    const store = createTuiStore()
    let called = 0
    store.subscribe(() => {
      called++
    })

    store.dispatch({ kind: "run_started", snapshot: runSnapshot() })
    expect(called).toBe(1)
  })

  test("unsubscribe stops notifications", () => {
    const store = createTuiStore()
    let called = 0
    const unsub = store.subscribe(() => {
      called++
    })
    unsub()

    store.dispatch({ kind: "run_started", snapshot: runSnapshot() })
    expect(called).toBe(0)
  })

  test("dispatch saves completed outputs on node_completed", () => {
    const store = createTuiStore()
    const snapshot = runSnapshot()
    store.dispatch({ kind: "run_started", snapshot })

    const node = {
      attempt: 1,
      duration_ms: 1200,
      exit_code: 0,
      finished_at: "2026-03-15T10:01:00.000Z",
      node_kind: "shell",
      node_path: "/0",
      result: null,
      started_at: "2026-03-15T10:00:00.000Z",
      status: "succeeded" as const,
      stderr: null,
      stdout: "Hello\n",
      user_id: "step-1",
      waiting_for: null,
    }

    store.dispatch({
      kind: "node_completed",
      node,
      snapshot: runSnapshot({ nodes: [node] }),
    })

    const completedOutputs = store.getSnapshot().state.completedOutputs
    expect(completedOutputs["/0"]).toBeDefined()
    expect(completedOutputs["/0"]?.preview).toEqual({
      stream: "stdout",
      text: "Hello",
    })
  })

  test("dispatch saves completed outputs for control nodes too", () => {
    const store = createTuiStore()
    store.dispatch({ kind: "run_started", snapshot: runSnapshot() })

    const groupNode = {
      attempt: 1,
      duration_ms: 1200,
      exit_code: null,
      finished_at: "2026-03-15T10:01:00.000Z",
      node_kind: "group",
      node_path: "/0",
      result: null,
      started_at: "2026-03-15T10:00:00.000Z",
      status: "succeeded" as const,
      stderr: null,
      stdout: null,
      user_id: null,
      waiting_for: null,
    }

    store.dispatch({
      kind: "node_completed",
      node: groupNode,
      snapshot: runSnapshot({ nodes: [groupNode] }),
    })

    const completedOutputs = store.getSnapshot().state.completedOutputs
    expect(completedOutputs["/0"]).toBeDefined()
    expect(completedOutputs["/0"]?.preview).toBeNull()
  })

  test("dispatch preserves control-node stderr previews", () => {
    const store = createTuiStore()
    store.dispatch({ kind: "run_started", snapshot: runSnapshot() })

    const groupNode = {
      attempt: 1,
      duration_ms: 1200,
      exit_code: null,
      finished_at: "2026-03-15T10:01:00.000Z",
      node_kind: "group",
      node_path: "/0",
      result: null,
      started_at: "2026-03-15T10:00:00.000Z",
      status: "failed" as const,
      stderr: "exports evaluation failed",
      stdout: null,
      user_id: null,
      waiting_for: null,
    }

    store.dispatch({
      kind: "node_completed",
      node: groupNode,
      snapshot: runSnapshot({ nodes: [groupNode] }),
    })

    expect(store.getSnapshot().state.completedOutputs["/0"]?.preview).toEqual({
      stream: "stderr",
      text: "exports evaluation failed",
    })
  })

  test("startTimer increments timerTick", async () => {
    const store = createTuiStore()
    timerCleanup = () => store.stopTimer()

    const initialTick = store.getSnapshot().timerTick
    store.startTimer()

    await new Promise((resolve) => setTimeout(resolve, 1100))

    expect(store.getSnapshot().timerTick).toBeGreaterThan(initialTick)
    store.stopTimer()
  })
})
