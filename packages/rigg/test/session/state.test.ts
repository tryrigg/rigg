import { describe, expect, test } from "bun:test"

import { initRunState, nextAttempt, finishRun, upsertNode } from "../../src/session/state"
import type { NodeSnapshot } from "../../src/session/schema"
import { runSnapshot } from "../fixture/builders"

function nodeSnapshot(overrides: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return {
    attempt: 1,
    duration_ms: null,
    exit_code: null,
    finished_at: null,
    node_kind: "shell",
    node_path: "/0",
    result: null,
    started_at: null,
    status: "pending",
    stderr: null,
    stdout: null,
    user_id: null,
    waiting_for: null,
    ...overrides,
  }
}

describe("session/state", () => {
  test("creates the initial run state", () => {
    expect(initRunState("run-1", "workflow", "2026-03-14T00:00:00.000Z")).toEqual(
      runSnapshot({
        run_id: "run-1",
        started_at: "2026-03-14T00:00:00.000Z",
        workflow_id: "workflow",
      }),
    )
  })

  test("marks runs as finished", () => {
    const state = initRunState("run-1", "workflow", "2026-03-14T00:00:00.000Z")

    finishRun(state, "failed", "step_failed", "2026-03-14T00:01:00.000Z")

    expect(state).toMatchObject({
      finished_at: "2026-03-14T00:01:00.000Z",
      reason: "step_failed",
      status: "failed",
    })
  })

  test("upserts node snapshots and keeps numeric order", () => {
    const state = initRunState("run-1", "workflow", "2026-03-14T00:00:00.000Z")

    upsertNode(state, nodeSnapshot({ node_path: "/10" }))
    upsertNode(state, nodeSnapshot({ node_path: "/2" }))
    upsertNode(
      state,
      nodeSnapshot({
        attempt: 2,
        duration_ms: 100,
        exit_code: 0,
        finished_at: "2026-03-14T00:01:00.000Z",
        node_path: "/2",
        result: "done",
        started_at: "2026-03-14T00:00:30.000Z",
        status: "succeeded",
        stdout: "done",
      }),
    )

    expect(state.nodes.map((node) => node.node_path)).toEqual(["/2", "/10"])
    expect(state.nodes[0]).toMatchObject({
      attempt: 2,
      status: "succeeded",
    })
  })

  test("computes next attempts from the latest snapshot", () => {
    const state = initRunState("run-1", "workflow", "2026-03-14T00:00:00.000Z")
    expect(nextAttempt(state, "/0")).toBe(1)

    upsertNode(state, nodeSnapshot({ attempt: 3 }))

    expect(nextAttempt(state, "/0")).toBe(4)
  })
})
