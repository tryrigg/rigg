import { describe, expect, test } from "bun:test"

import type { WorkflowDocument, WorkflowStep } from "../../../src/compile/schema"
import { formatStepProgress, summarizeStepProgress } from "../../../src/cli/tui/step-progress"
import type { FrontierNode, NodeSnapshot, RunSnapshot } from "../../../src/run/schema"
import { runSnapshot } from "../../fixture/builders"

function workflow(steps: WorkflowStep[]): WorkflowDocument {
  return { id: "test", steps }
}

function nodeSnapshot(overrides: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return {
    attempt: 1,
    duration_ms: null,
    exit_code: null,
    finished_at: null,
    node_kind: "shell",
    node_path: "/0",
    progress: undefined,
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

function frontierNode(overrides: Partial<FrontierNode> = {}): FrontierNode {
  return {
    frame_id: "root",
    node_kind: "shell",
    node_path: "/0",
    ...overrides,
  }
}

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return runSnapshot(overrides)
}

describe("summarizeStepProgress", () => {
  test("counts static non-loop actions before they start", () => {
    const summary = summarizeStepProgress(
      workflow([
        { id: "first", type: "shell", with: { command: "echo first" } },
        { id: "second", type: "shell", with: { command: "echo second" } },
      ]),
      snapshot(),
    )

    expect(summary).toEqual({ completed: 0, total: 2 })
    expect(formatStepProgress(summary)).toBe("0/2 steps")
  })

  test("counts queued loop iterations as additional runtime work", () => {
    const summary = summarizeStepProgress(
      workflow([
        {
          id: "loop",
          max: 5,
          steps: [{ id: "retry", type: "shell", with: { command: "echo retry" } }],
          type: "loop",
          until: "${{ false }}",
        },
      ]),
      snapshot({
        active_barrier: {
          barrier_id: "barrier-1",
          completed: null,
          created_at: "2026-03-17T00:00:00.000Z",
          frame_id: "root.loop.iter.2",
          next: [frontierNode({ node_path: "/0/0" })],
          reason: "loop_iteration_started",
        },
        nodes: [
          nodeSnapshot({
            attempt: 1,
            finished_at: "2026-03-17T00:00:01.000Z",
            node_path: "/0/0",
            started_at: "2026-03-17T00:00:00.000Z",
            status: "succeeded",
            user_id: "retry",
          }),
        ],
      }),
    )

    expect(summary).toEqual({ completed: 1, total: 2 })
  })

  test("keeps future non-loop actions in the total while loops expand at runtime", () => {
    const summary = summarizeStepProgress(
      workflow([
        {
          id: "loop",
          max: 5,
          steps: [{ id: "retry", type: "shell", with: { command: "echo retry" } }],
          type: "loop",
          until: "${{ false }}",
        },
        { id: "finalize", type: "shell", with: { command: "echo done" } },
      ]),
      snapshot({
        active_barrier: {
          barrier_id: "barrier-1",
          completed: null,
          created_at: "2026-03-17T00:00:00.000Z",
          frame_id: "root.loop.iter.2",
          next: [frontierNode({ node_path: "/0/0" })],
          reason: "loop_iteration_started",
        },
        nodes: [
          nodeSnapshot({
            attempt: 1,
            finished_at: "2026-03-17T00:00:01.000Z",
            node_path: "/0/0",
            started_at: "2026-03-17T00:00:00.000Z",
            status: "succeeded",
            user_id: "retry",
          }),
        ],
      }),
    )

    expect(summary).toEqual({ completed: 1, total: 3 })
  })

  test("uses action attempts for partially completed loop bodies", () => {
    const summary = summarizeStepProgress(
      workflow([
        {
          id: "loop",
          max: 5,
          steps: [
            { id: "first", type: "shell", with: { command: "echo first" } },
            { id: "second", type: "shell", with: { command: "echo second" } },
          ],
          type: "loop",
          until: "${{ false }}",
        },
      ]),
      snapshot({
        nodes: [
          nodeSnapshot({
            attempt: 2,
            node_path: "/0/0",
            started_at: "2026-03-17T00:00:02.000Z",
            status: "running",
            user_id: "first",
          }),
          nodeSnapshot({
            attempt: 1,
            finished_at: "2026-03-17T00:00:01.000Z",
            node_path: "/0/1",
            started_at: "2026-03-17T00:00:00.000Z",
            status: "succeeded",
            user_id: "second",
          }),
        ],
      }),
    )

    expect(summary).toEqual({ completed: 2, total: 3 })
  })
})
