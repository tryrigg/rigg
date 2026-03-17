import { describe, expect, test } from "bun:test"

import type { WorkflowDocument, WorkflowStep } from "../../../src/compile/schema"
import type { RunSnapshot } from "../../../src/run/schema"
import { buildTree, extractDetail } from "../../../src/cli/tui/tree"
import { runSnapshot } from "../../fixture/builders"

function workflow(steps: WorkflowStep[]): WorkflowDocument {
  return { id: "test", steps }
}

describe("buildTree", () => {
  test("builds flat list for sequential workflow", () => {
    const wf = workflow([
      { type: "shell", with: { command: "echo hello" } },
      { type: "codex", with: { action: "run", prompt: "do stuff" } },
      { type: "write_file", with: { path: "out.txt", content: "hi" } },
    ])

    const entries = buildTree(wf, null)
    const stepEntries = entries.filter((e) => e.entryType === "step")
    expect(stepEntries.length).toBe(3)
    expect(stepEntries[0]?.nodeKind).toBe("shell")
    expect(stepEntries[0]?.nodePath).toBe("/0")
    expect(stepEntries[0]?.status).toBe("not_started")
    expect(stepEntries[0]?.entryType).toBe("step")
    expect(stepEntries[1]?.nodeKind).toBe("codex")
    expect(stepEntries[1]?.nodePath).toBe("/1")
    expect(stepEntries[2]?.nodeKind).toBe("write_file")
    expect(stepEntries[2]?.nodePath).toBe("/2")
  })

  test("reflects snapshot status in tree entries", () => {
    const wf = workflow([
      { id: "step-a", type: "shell", with: { command: "echo a" } },
      { id: "step-b", type: "shell", with: { command: "echo b" } },
    ])
    const snapshot: RunSnapshot = runSnapshot({
      nodes: [
        {
          attempt: 1,
          duration_ms: 1200,
          exit_code: 0,
          finished_at: "2026-03-15T10:01:00.000Z",
          node_kind: "shell",
          node_path: "/0",
          result: null,
          started_at: "2026-03-15T10:00:00.000Z",
          status: "succeeded",
          stderr: null,
          stdout: "done",
          user_id: "step-a",
          waiting_for: null,
        },
        {
          attempt: 1,
          duration_ms: null,
          exit_code: null,
          finished_at: null,
          node_kind: "shell",
          node_path: "/1",
          result: null,
          started_at: "2026-03-15T10:01:00.000Z",
          status: "running",
          stderr: null,
          stdout: null,
          user_id: "step-b",
          waiting_for: null,
        },
      ],
    })

    const entries = buildTree(wf, snapshot)
    const stepEntries = entries.filter((e) => e.entryType === "step")
    expect(stepEntries[0]?.status).toBe("succeeded")
    expect(stepEntries[0]?.suffix).toBe("1.2s")
    expect(stepEntries[1]?.status).toBe("running")
    expect(stepEntries[1]?.isActive).toBe(true)
  })

  test("treats waiting_for_interaction steps as active", () => {
    const wf = workflow([
      { id: "step-a", type: "shell", with: { command: "echo a" } },
      { id: "step-b", type: "shell", with: { command: "echo b" } },
      { id: "step-c", type: "shell", with: { command: "echo c" } },
    ])
    const snapshot: RunSnapshot = runSnapshot({
      nodes: [
        {
          attempt: 1,
          duration_ms: 1200,
          exit_code: 0,
          finished_at: "2026-03-15T10:01:00.000Z",
          node_kind: "shell",
          node_path: "/0",
          result: null,
          started_at: "2026-03-15T10:00:00.000Z",
          status: "succeeded",
          stderr: null,
          stdout: "done",
          user_id: "step-a",
          waiting_for: null,
        },
        {
          attempt: 1,
          duration_ms: null,
          exit_code: null,
          finished_at: null,
          node_kind: "shell",
          node_path: "/1",
          result: null,
          started_at: "2026-03-15T10:01:00.000Z",
          status: "waiting_for_interaction",
          stderr: null,
          stdout: null,
          user_id: "step-b",
          waiting_for: "approval",
        },
      ],
    })

    const entries = buildTree(wf, snapshot)
    const stepEntries = entries.filter((e) => e.entryType === "step")
    expect(stepEntries[1]?.status).toBe("waiting_for_interaction")
    expect(stepEntries[1]?.isActive).toBe(true)
    expect(stepEntries[2]?.isNext).toBe(false)
  })

  test("builds parallel branch entries with labels", () => {
    const wf = workflow([
      {
        type: "parallel",
        branches: [
          { id: "left", steps: [{ type: "shell", with: { command: "echo left" } }] },
          { id: "right", steps: [{ type: "shell", with: { command: "echo right" } }] },
        ],
      },
    ])

    const entries = buildTree(wf, null)
    expect(entries[0]?.nodeKind).toBe("parallel")
    expect(entries[0]?.entryType).toBe("step")
    expect(entries[0]?.depth).toBe(0)
    expect(entries[0]?.meta).toBe("2 branches")

    expect(entries[1]?.entryType).toBe("label")
    expect(entries[1]?.label).toBe("left")

    const leftShell = entries[2]
    expect(leftShell?.entryType).toBe("step")
    expect(leftShell?.nodeKind).toBe("shell")
    expect(leftShell?.depth).toBe(1)
    expect(leftShell?.prefix).toBe("│  ")

    expect(entries[3]?.entryType).toBe("label")
    expect(entries[3]?.label).toBe("right")

    const rightShell = entries[4]
    expect(rightShell?.entryType).toBe("step")
    expect(rightShell?.nodeKind).toBe("shell")
    expect(rightShell?.depth).toBe(1)
  })

  test("builds loop entries with iteration meta", () => {
    const wf = workflow([
      {
        type: "loop",
        max: 5,
        until: "done",
        steps: [{ type: "shell", with: { command: "echo iter" } }],
      },
    ])

    const entries = buildTree(wf, null)
    expect(entries[0]?.nodeKind).toBe("loop")
    expect(entries[0]?.entryType).toBe("step")
    expect(entries[0]?.meta).toBe("iter 0/5 · max 5")

    const child = entries[1]
    expect(child?.entryType).toBe("step")
    expect(child?.depth).toBe(1)
    expect(child?.prefix).toBe("│  ")
  })

  test("uses loop progress from the loop node snapshot", () => {
    const wf = workflow([
      {
        id: "loop",
        type: "loop",
        max: 5,
        until: "done",
        steps: [
          { id: "first", type: "shell", with: { command: "echo first" } },
          { id: "second", type: "shell", with: { command: "echo second" } },
        ],
      },
    ])
    const snapshot: RunSnapshot = runSnapshot({
      nodes: [
        {
          attempt: 1,
          duration_ms: null,
          exit_code: null,
          finished_at: null,
          node_kind: "loop",
          node_path: "/0",
          progress: {
            current_iteration: 2,
            max_iterations: 5,
          },
          result: null,
          started_at: "2026-03-15T10:00:00.000Z",
          status: "running",
          stderr: null,
          stdout: null,
          user_id: "loop",
          waiting_for: null,
        },
        {
          attempt: 2,
          duration_ms: null,
          exit_code: null,
          finished_at: null,
          node_kind: "shell",
          node_path: "/0/0",
          result: null,
          started_at: "2026-03-15T10:01:00.000Z",
          status: "running",
          stderr: null,
          stdout: null,
          user_id: "first",
          waiting_for: null,
        },
        {
          attempt: 1,
          duration_ms: 1000,
          exit_code: 0,
          finished_at: "2026-03-15T10:00:30.000Z",
          node_kind: "shell",
          node_path: "/0/1",
          result: null,
          started_at: "2026-03-15T10:00:00.000Z",
          status: "succeeded",
          stderr: null,
          stdout: "done",
          user_id: "second",
          waiting_for: null,
        },
      ],
    })

    const entries = buildTree(wf, snapshot)
    expect(entries[0]?.meta).toBe("iter 2/5 · max 5")
    expect(entries[1]?.entryType).toBe("label")
    expect(entries[1]?.label).toBe("iteration 2")
  })

  test("builds branch entries with cases", () => {
    const wf = workflow([
      {
        type: "branch",
        cases: [
          { if: "inputs.fast", steps: [{ type: "shell", with: { command: "echo fast" } }] },
          { else: true, steps: [{ type: "shell", with: { command: "echo slow" } }] },
        ],
      },
    ])

    const entries = buildTree(wf, null)
    expect(entries[0]?.nodeKind).toBe("branch")
    expect(entries[0]?.entryType).toBe("step")

    expect(entries[1]?.label).toBe("inputs.fast")
    expect(entries[1]?.depth).toBe(1)
    expect(entries[1]?.prefix).toBe("│  ")

    expect(entries[2]?.depth).toBe(2)
    expect(entries[2]?.prefix).toBe("│     ")

    expect(entries[3]?.label).toBe("else")

    expect(entries[4]?.depth).toBe(2)
  })

  test("derives branch case status from descendant snapshots when no direct case snapshot exists", () => {
    const wf = workflow([
      {
        id: "branch",
        type: "branch",
        cases: [
          { if: "inputs.fast", steps: [{ id: "fast", type: "shell", with: { command: "echo fast" } }] },
          { else: true, steps: [{ id: "slow", type: "shell", with: { command: "echo slow" } }] },
        ],
      },
    ])
    const snapshot: RunSnapshot = runSnapshot({
      nodes: [
        {
          attempt: 1,
          duration_ms: null,
          exit_code: null,
          finished_at: null,
          node_kind: "branch",
          node_path: "/0",
          result: null,
          started_at: "2026-03-15T10:00:00.000Z",
          status: "running",
          stderr: null,
          stdout: null,
          user_id: "branch",
          waiting_for: null,
        },
        {
          attempt: 1,
          duration_ms: null,
          exit_code: null,
          finished_at: null,
          node_kind: "shell",
          node_path: "/0/0/0",
          result: null,
          started_at: "2026-03-15T10:00:01.000Z",
          status: "running",
          stderr: null,
          stdout: null,
          user_id: "fast",
          waiting_for: null,
        },
        {
          attempt: 1,
          duration_ms: 0,
          exit_code: null,
          finished_at: "2026-03-15T10:00:01.000Z",
          node_kind: "shell",
          node_path: "/0/1/0",
          result: null,
          started_at: "2026-03-15T10:00:01.000Z",
          status: "skipped",
          stderr: null,
          stdout: null,
          user_id: "slow",
          waiting_for: null,
        },
      ],
    })

    const entries = buildTree(wf, snapshot)
    expect(entries[1]?.status).toBe("running")
    expect(entries[3]?.status).toBe("skipped")
  })

  test("uses step id as label when available", () => {
    const wf = workflow([{ id: "gather-context", type: "shell", with: { command: "echo hi" } }])

    const entries = buildTree(wf, null)
    const stepEntries = entries.filter((e) => e.entryType === "step")
    expect(stepEntries[0]?.label).toBe("gather-context")
  })

  test("group node recurses into children with indentation", () => {
    const wf = workflow([
      {
        type: "group",
        steps: [
          { type: "shell", with: { command: "echo a" } },
          { type: "shell", with: { command: "echo b" } },
        ],
      },
    ])

    const entries = buildTree(wf, null)
    expect(entries[0]?.nodeKind).toBe("group")
    expect(entries[0]?.depth).toBe(0)
    expect(entries[0]?.entryType).toBe("step")
    expect(entries[0]?.meta).toBe("2 steps")

    expect(entries[1]?.depth).toBe(1)
    expect(entries[1]?.prefix).toBe("│  ")
    expect(entries[2]?.depth).toBe(1)
    expect(entries[2]?.prefix).toBe("│  ")
  })
})

describe("extractDetail", () => {
  test("returns command for shell steps", () => {
    const step: WorkflowStep = { type: "shell", with: { command: "echo hello" } }
    expect(extractDetail(step)).toBe("$ echo hello")
  })

  test("truncates long shell commands", () => {
    const longCmd = "echo " + "a".repeat(80)
    const step: WorkflowStep = { type: "shell", with: { command: longCmd } }
    const detail = extractDetail(step)
    expect(detail?.startsWith("$ ")).toBe(true)
    expect(detail!.length).toBeLessThanOrEqual(62)
    expect(detail?.endsWith("...")).toBe(true)
  })

  test("returns first line for multiline shell commands", () => {
    const step: WorkflowStep = { type: "shell", with: { command: "echo first\necho second" } }
    expect(extractDetail(step)).toBe("$ echo first")
  })

  test("returns action for codex steps", () => {
    const step: WorkflowStep = { type: "codex", with: { action: "run", prompt: "do stuff" } }
    expect(extractDetail(step)).toBe("run")
  })

  test("returns action and model for codex steps with model", () => {
    const step: WorkflowStep = { type: "codex", with: { action: "run", prompt: "do stuff", model: "o3" } }
    expect(extractDetail(step)).toBe("run · o3")
  })

  test("returns action, model and effort for codex steps", () => {
    const step: WorkflowStep = {
      type: "codex",
      with: { action: "run", prompt: "do stuff", model: "o3", effort: "high" },
    }
    expect(extractDetail(step)).toBe("run · o3 · high")
  })

  test("returns action and effort for codex steps without model", () => {
    const step: WorkflowStep = { type: "codex", with: { action: "run", prompt: "do stuff", effort: "low" } }
    expect(extractDetail(step)).toBe("run · low")
  })

  test("returns path for write_file steps", () => {
    const step: WorkflowStep = { type: "write_file", with: { path: "out.txt", content: "hi" } }
    expect(extractDetail(step)).toBe("→ out.txt")
  })

  test("returns undefined for container steps", () => {
    const step: WorkflowStep = { type: "group", steps: [{ type: "shell", with: { command: "echo a" } }] }
    expect(extractDetail(step)).toBeUndefined()
  })
})

describe("annotateNext", () => {
  test("marks barrier frontier entries", () => {
    const wf = workflow([
      {
        id: "fanout",
        type: "parallel",
        branches: [
          {
            id: "left",
            steps: [{ id: "left-step", type: "shell", with: { command: "echo left" } }],
          },
          {
            id: "right",
            steps: [{ id: "right-step", type: "shell", with: { command: "echo right" } }],
          },
        ],
      },
    ])
    const snapshot: RunSnapshot = runSnapshot({
      active_barrier: {
        barrier_id: "barrier-1",
        completed: null,
        created_at: "2026-03-15T10:00:00.000Z",
        frame_id: "root",
        next: [
          {
            action: "shell",
            cwd: "/workspace",
            detail: "echo left",
            frame_id: "root",
            model: null,
            node_kind: "shell",
            node_path: "/0/0/0",
            prompt_preview: null,
            user_id: "left-step",
          },
          {
            action: "shell",
            cwd: "/workspace",
            detail: "echo right",
            frame_id: "root",
            model: null,
            node_kind: "shell",
            node_path: "/0/1/0",
            prompt_preview: null,
            user_id: "right-step",
          },
        ],
        reason: "run_started",
      },
      phase: "waiting_for_barrier",
      status: "running",
    })

    const entries = buildTree(wf, snapshot)
    const stepEntries = entries.filter((e) => e.entryType === "step")
    expect(stepEntries.find((e) => e.nodePath === "/0/0/0")?.isNext).toBe(true)
    expect(stepEntries.find((e) => e.nodePath === "/0/1/0")?.isNext).toBe(true)
  })

  test("does not mark another next step while waiting for interaction", () => {
    const wf = workflow([
      { id: "a", type: "shell", with: { command: "echo a" } },
      { id: "b", type: "shell", with: { command: "echo b" } },
      { id: "c", type: "shell", with: { command: "echo c" } },
    ])
    const snapshot: RunSnapshot = runSnapshot({
      nodes: [
        {
          attempt: 1,
          duration_ms: 1200,
          exit_code: 0,
          finished_at: "2026-03-15T10:01:00.000Z",
          node_kind: "shell",
          node_path: "/0",
          result: null,
          started_at: "2026-03-15T10:00:00.000Z",
          status: "succeeded",
          stderr: null,
          stdout: "done",
          user_id: "a",
          waiting_for: null,
        },
        {
          attempt: 1,
          duration_ms: null,
          exit_code: null,
          finished_at: null,
          node_kind: "shell",
          node_path: "/1",
          result: null,
          started_at: "2026-03-15T10:01:00.000Z",
          status: "waiting_for_interaction",
          stderr: null,
          stdout: null,
          user_id: "b",
          waiting_for: "approval",
        },
      ],
    })

    const entries = buildTree(wf, snapshot)
    const stepEntries = entries.filter((e) => e.entryType === "step")
    expect(stepEntries[0]?.isNext).toBe(false)
    expect(stepEntries[1]?.isNext).toBe(false)
    expect(stepEntries[2]?.isNext).toBe(false)
  })

  test("does not mark next after the run has finished", () => {
    const wf = workflow([
      { id: "a", type: "shell", with: { command: "echo a" } },
      { id: "b", type: "shell", with: { command: "echo b" } },
    ])
    const snapshot: RunSnapshot = runSnapshot({
      finished_at: "2026-03-15T10:01:00.000Z",
      nodes: [
        {
          attempt: 1,
          duration_ms: 1200,
          exit_code: 9,
          finished_at: "2026-03-15T10:01:00.000Z",
          node_kind: "shell",
          node_path: "/0",
          result: null,
          started_at: "2026-03-15T10:00:00.000Z",
          status: "failed",
          stderr: "boom",
          stdout: null,
          user_id: "a",
          waiting_for: null,
        },
      ],
      phase: "failed",
      reason: "step_failed",
      status: "failed",
    })

    const entries = buildTree(wf, snapshot)
    const stepEntries = entries.filter((e) => e.entryType === "step")
    expect(stepEntries[0]?.isNext).toBe(false)
    expect(stepEntries[1]?.isNext).toBe(false)
  })
})

describe("prefix", () => {
  test("nested entries get │-rail indent per container depth", () => {
    const wf = workflow([
      {
        type: "group",
        steps: [
          {
            type: "group",
            steps: [{ type: "shell", with: { command: "echo deep" } }],
          },
        ],
      },
    ])

    const entries = buildTree(wf, null)
    const stepEntries = entries.filter((e) => e.entryType === "step")
    expect(stepEntries[0]?.prefix).toBe("")
    expect(stepEntries[1]?.prefix).toBe("│  ")
    expect(stepEntries[2]?.prefix).toBe("│  │  ")
  })

  test("branch case children get │-rail prefix", () => {
    const wf = workflow([
      {
        type: "branch",
        cases: [{ if: "true", steps: [{ type: "shell", with: { command: "echo fast" } }] }],
      },
    ])

    const entries = buildTree(wf, null)
    const shellEntry = entries.find((e) => e.entryType === "step" && e.nodeKind === "shell")
    expect(shellEntry?.prefix).toBe("│     ")
  })
})

describe("container meta", () => {
  test("group shows step count", () => {
    const wf = workflow([
      {
        type: "group",
        steps: [
          { type: "shell", with: { command: "echo a" } },
          { type: "shell", with: { command: "echo b" } },
          { type: "shell", with: { command: "echo c" } },
        ],
      },
    ])

    const entries = buildTree(wf, null)
    expect(entries[0]?.meta).toBe("3 steps")
  })

  test("parallel shows branch count", () => {
    const wf = workflow([
      {
        type: "parallel",
        branches: [
          { id: "a", steps: [{ type: "shell", with: { command: "echo a" } }] },
          { id: "b", steps: [{ type: "shell", with: { command: "echo b" } }] },
          { id: "c", steps: [{ type: "shell", with: { command: "echo c" } }] },
        ],
      },
    ])

    const entries = buildTree(wf, null)
    expect(entries[0]?.meta).toBe("3 branches")
  })
})
