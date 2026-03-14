import { describe, expect, test } from "bun:test"

import {
  createInitialRunState,
  nextNodeAttempt,
  replaceConversations,
  setRunFinished,
  upsertNodeSnapshot,
} from "../../src/run/state"
import { runSnapshot } from "../fixture/builders"

describe("run/state", () => {
  test("creates the initial run state", () => {
    expect(createInitialRunState("run-1", "workflow", "2026-03-14T00:00:00.000Z")).toEqual(
      runSnapshot({
        run_id: "run-1",
        started_at: "2026-03-14T00:00:00.000Z",
        workflow_id: "workflow",
      }),
    )
  })

  test("marks runs as finished", () => {
    const state = createInitialRunState("run-1", "workflow", "2026-03-14T00:00:00.000Z")

    setRunFinished(state, "failed", "step_failed", "2026-03-14T00:01:00.000Z")

    expect(state).toMatchObject({
      finished_at: "2026-03-14T00:01:00.000Z",
      reason: "step_failed",
      status: "failed",
    })
  })

  test("upserts node snapshots and keeps numeric order", () => {
    const state = createInitialRunState("run-1", "workflow", "2026-03-14T00:00:00.000Z")

    upsertNodeSnapshot(state, {
      attempt: 1,
      duration_ms: null,
      exit_code: null,
      finished_at: null,
      node_path: "/10",
      result: null,
      started_at: null,
      status: "pending",
      stderr: null,
      stderr_path: null,
      stderr_preview: "",
      stdout: null,
      stdout_path: null,
      stdout_preview: "",
      user_id: null,
    })
    upsertNodeSnapshot(state, {
      attempt: 1,
      duration_ms: null,
      exit_code: null,
      finished_at: null,
      node_path: "/2",
      result: null,
      started_at: null,
      status: "pending",
      stderr: null,
      stderr_path: null,
      stderr_preview: "",
      stdout: null,
      stdout_path: null,
      stdout_preview: "",
      user_id: null,
    })
    upsertNodeSnapshot(state, {
      attempt: 2,
      duration_ms: 100,
      exit_code: 0,
      finished_at: "2026-03-14T00:01:00.000Z",
      node_path: "/2",
      result: "done",
      started_at: "2026-03-14T00:00:30.000Z",
      status: "succeeded",
      stderr: null,
      stderr_path: null,
      stderr_preview: "",
      stdout: "done",
      stdout_path: null,
      stdout_preview: "done",
      user_id: null,
    })

    expect(state.nodes.map((node) => node.node_path)).toEqual(["/2", "/10"])
    expect(state.nodes[0]).toMatchObject({
      attempt: 2,
      status: "succeeded",
    })
  })

  test("replaces conversations by value and computes next attempts", () => {
    const state = createInitialRunState("run-1", "workflow", "2026-03-14T00:00:00.000Z")
    const conversations = { draft: { id: "claude-1", provider: "claude" as const } }

    replaceConversations(state, conversations)
    conversations.draft = { id: "claude-2", provider: "claude" }

    expect(state.conversations).toEqual({ draft: { id: "claude-1", provider: "claude" } })
    expect(nextNodeAttempt(state, "/0")).toBe(1)

    upsertNodeSnapshot(state, {
      attempt: 3,
      duration_ms: null,
      exit_code: null,
      finished_at: null,
      node_path: "/0",
      result: null,
      started_at: null,
      status: "pending",
      stderr: null,
      stderr_path: null,
      stderr_preview: "",
      stdout: null,
      stdout_path: null,
      stdout_preview: "",
      user_id: null,
    })

    expect(nextNodeAttempt(state, "/0")).toBe(4)
  })
})
