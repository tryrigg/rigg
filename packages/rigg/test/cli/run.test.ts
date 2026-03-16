import { describe, expect, test } from "bun:test"

import {
  applyRunEvent,
  createNonInteractiveRunSession,
  createTerminalUiState,
  renderTerminalFrame,
} from "../../src/cli/run"
import type { FrontierNode, NodeSnapshot } from "../../src/run/schema"
import { runSnapshot } from "../fixture/builders"

function nodeSnapshot(overrides: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return {
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
    stdout: "Done.",
    user_id: "deploy-config",
    waiting_for: null,
    ...overrides,
  }
}

function barrierSnapshot(
  overrides: {
    completedNode?: Partial<NodeSnapshot>
    next?: FrontierNode[]
  } = {},
) {
  const completed = nodeSnapshot(overrides.completedNode)
  return runSnapshot({
    active_barrier: {
      barrier_id: "barrier-1",
      completed: {
        node_kind: completed.node_kind,
        node_path: completed.node_path,
        result: completed.result,
        status: completed.status,
        user_id: completed.user_id,
      },
      created_at: "2026-03-15T10:01:00.000Z",
      frame_id: "root",
      next: overrides.next ?? [
        {
          cwd: "/app",
          frame_id: "root",
          node_kind: "shell",
          node_path: "/1",
          user_id: "run-migrations",
        },
      ],
      reason: "step_completed",
    },
    nodes: [completed],
    phase: "waiting_for_barrier",
  })
}

describe("cli/run", () => {
  test("renders running output without pane or provider transcript UI", () => {
    const snapshot = runSnapshot({
      nodes: [nodeSnapshot({ finished_at: null, status: "running", stdout: null, duration_ms: null, exit_code: null })],
    })
    const state = createTerminalUiState()

    applyRunEvent(state, { kind: "run_started", snapshot })
    applyRunEvent(state, {
      kind: "node_started",
      node: snapshot.nodes[0]!,
      snapshot,
    })
    applyRunEvent(state, {
      chunk: "Deploying to staging...\nConfig validated: 12 entries\n",
      kind: "step_output",
      node_path: "/0",
      stream: "stdout",
      user_id: "deploy-config",
    })

    const frame = renderTerminalFrame(state)
    expect(frame).toContain("Status   : running")
    expect(frame).toContain("Running: deploy-config [shell]")
    expect(frame).toContain("  > Deploying to staging...")
    expect(frame).toContain("  > Config validated: 12 entries")
    expect(frame).not.toContain("Active Pane")
    expect(frame).not.toContain("Interaction Pane")
    expect(frame).not.toContain("inspect-output")
  })

  test("renders codex provider activity inside the running view", () => {
    const snapshot = runSnapshot({
      nodes: [
        nodeSnapshot({
          node_kind: "codex",
          finished_at: null,
          status: "running",
          stdout: null,
          duration_ms: null,
          exit_code: null,
        }),
      ],
    })
    const state = createTerminalUiState()

    applyRunEvent(state, { kind: "run_started", snapshot })
    applyRunEvent(state, {
      kind: "node_started",
      node: snapshot.nodes[0]!,
      snapshot,
    })
    applyRunEvent(state, {
      event: {
        itemId: "msg-1",
        kind: "message_delta",
        provider: "codex",
        text: "Reviewing the diff",
        threadId: "thread-1",
        turnId: "turn-1",
      },
      kind: "provider_event",
      node_path: "/0",
      user_id: "deploy-config",
    })
    applyRunEvent(state, {
      event: {
        detail: "rg TODO src",
        itemId: "tool-1",
        kind: "tool_started",
        provider: "codex",
        threadId: "thread-1",
        tool: "shell",
        turnId: "turn-1",
      },
      kind: "provider_event",
      node_path: "/0",
      user_id: "deploy-config",
    })
    applyRunEvent(state, {
      event: {
        kind: "diagnostic",
        message: "Waiting for tool output",
        provider: "codex",
        threadId: "thread-1",
        turnId: "turn-1",
      },
      kind: "provider_event",
      node_path: "/0",
      user_id: "deploy-config",
    })
    applyRunEvent(state, {
      event: {
        itemId: "msg-1",
        kind: "message_completed",
        provider: "codex",
        text: "Reviewing the diff and checking TODO handling.",
        threadId: "thread-1",
        turnId: "turn-1",
      },
      kind: "provider_event",
      node_path: "/0",
      user_id: "deploy-config",
    })

    const frame = renderTerminalFrame(state)
    expect(frame).toContain("Running: deploy-config [codex]")
    expect(frame).toContain("  > Reviewing the diff and checking TODO handling.")
    expect(frame).toContain("  > [codex] tool started: shell (rg TODO src)")
    expect(frame).toContain("  > [codex] diagnostic: Waiting for tool output")
  })

  test("keeps rendering surviving parallel nodes after a sibling completes", () => {
    const leftRunning = nodeSnapshot({
      duration_ms: null,
      exit_code: null,
      finished_at: null,
      node_path: "/0/0/0",
      stdout: null,
      status: "running",
      user_id: "left-step",
    })
    const rightRunning = nodeSnapshot({
      duration_ms: null,
      exit_code: null,
      finished_at: null,
      node_path: "/0/1/0",
      stdout: null,
      status: "running",
      user_id: "right-step",
    })
    const rightCompleted = nodeSnapshot({
      node_path: "/0/1/0",
      status: "succeeded",
      stdout: "right done\n",
      user_id: "right-step",
    })
    const initialSnapshot = runSnapshot({
      nodes: [leftRunning],
    })
    const parallelSnapshot = runSnapshot({
      nodes: [leftRunning, rightRunning],
    })
    const afterRightCompletion = runSnapshot({
      nodes: [leftRunning, rightCompleted],
    })
    const state = createTerminalUiState()

    applyRunEvent(state, { kind: "run_started", snapshot: initialSnapshot })
    applyRunEvent(state, {
      kind: "node_started",
      node: leftRunning,
      snapshot: initialSnapshot,
    })
    applyRunEvent(state, {
      chunk: "left branch still running\n",
      kind: "step_output",
      node_path: leftRunning.node_path,
      stream: "stdout",
      user_id: leftRunning.user_id ?? null,
    })
    applyRunEvent(state, {
      kind: "node_started",
      node: rightRunning,
      snapshot: parallelSnapshot,
    })
    applyRunEvent(state, {
      chunk: "right branch finishing\n",
      kind: "step_output",
      node_path: rightRunning.node_path,
      stream: "stdout",
      user_id: rightRunning.user_id ?? null,
    })
    applyRunEvent(state, {
      kind: "node_completed",
      node: rightCompleted,
      snapshot: afterRightCompletion,
    })

    const frame = renderTerminalFrame(state)
    expect(frame).toContain("Running: left-step [shell]")
    expect(frame).toContain("  > left branch still running")
    expect(frame).not.toContain("Running: right-step [shell]")
  })

  test("renders barrier with succeeded step output", () => {
    const snapshot = barrierSnapshot({
      completedNode: {
        stdout: "Deploying to staging...\nConfig validated: 12 entries\nDone.\n",
      },
    })
    const state = createTerminalUiState()

    applyRunEvent(state, { kind: "run_started", snapshot })
    applyRunEvent(state, {
      barrier: snapshot.active_barrier!,
      kind: "barrier_reached",
      snapshot,
    })

    const frame = renderTerminalFrame(state)
    expect(frame).toContain("Status   : waiting")
    expect(frame).toContain("--- deploy-config (succeeded, exit 0, 1.2s) ---")
    expect(frame).toContain("  Deploying to staging...")
    expect(frame).toContain("  Config validated: 12 entries")
    expect(frame).toContain("Next: run-migrations [shell] cwd=/app")
    expect(frame).toContain("[c]ontinue  [a]bort")
  })

  test("renders barrier with truncated successful output, stderr, and no-output cases", () => {
    const longOutputSnapshot = barrierSnapshot({
      completedNode: {
        stdout: "1\n2\n3\n4\n5\n6\n7\n",
      },
    })
    const stderrSnapshot = barrierSnapshot({
      completedNode: {
        stderr: "warning: retrying\nwarning: fallback\n",
        stdout: "",
      },
    })
    const noOutputSnapshot = barrierSnapshot({
      completedNode: {
        stderr: "",
        stdout: "",
      },
    })

    const longFrame = renderTerminalFrame({
      lastCompletedNodePath: "/0",
      liveOutputs: {},
      snapshot: longOutputSnapshot,
    })
    expect(longFrame).toContain("  1")
    expect(longFrame).toContain("  5")
    expect(longFrame).toContain("  … +2 lines")

    const stderrFrame = renderTerminalFrame({
      lastCompletedNodePath: "/0",
      liveOutputs: {},
      snapshot: stderrSnapshot,
    })
    expect(stderrFrame).toContain("  (no output)")
    expect(stderrFrame).toContain("  stderr:")
    expect(stderrFrame).toContain("    warning: retrying")

    const noOutputFrame = renderTerminalFrame({
      lastCompletedNodePath: "/0",
      liveOutputs: {},
      snapshot: noOutputSnapshot,
    })
    expect(noOutputFrame).toContain("  (no output)")
  })

  test("renders barrier with failed stdout and stderr sections", () => {
    const snapshot = barrierSnapshot({
      completedNode: {
        exit_code: 1,
        status: "failed",
        stderr: "Error: connection refused\nat pool.ts:42\n",
        stdout: "Deploying to staging...\nConfig validated: 12 entries\n",
      },
    })

    const frame = renderTerminalFrame({
      lastCompletedNodePath: "/0",
      liveOutputs: {},
      snapshot,
    })

    expect(frame).toContain("--- deploy-config (failed, exit 1, 1.2s) ---")
    expect(frame).toContain("  stdout:")
    expect(frame).toContain("    Deploying to staging...")
    expect(frame).toContain("  stderr:")
    expect(frame).toContain("    Error: connection refused")
  })

  test("omits the result section for the first barrier", () => {
    const snapshot = runSnapshot({
      active_barrier: {
        barrier_id: "barrier-1",
        completed: null,
        created_at: "2026-03-15T10:01:00.000Z",
        frame_id: "root",
        next: [
          {
            cwd: "/app",
            frame_id: "root",
            node_kind: "shell",
            node_path: "/0",
            user_id: "deploy-config",
          },
        ],
        reason: "run_started",
      },
      nodes: [],
      phase: "waiting_for_barrier",
    })

    const frame = renderTerminalFrame({
      lastCompletedNodePath: null,
      liveOutputs: {},
      snapshot,
    })

    expect(frame).toContain("Next: deploy-config [shell] cwd=/app")
    expect(frame).not.toContain("--- ")
  })

  test("renders approval, user input, and elicitation in the shared waiting frame", () => {
    const approvalSnapshot = runSnapshot({
      active_interaction: {
        created_at: "2026-03-15T10:01:00.000Z",
        interaction_id: "approval-1",
        kind: "approval",
        node_path: "/1",
        request: {
          command: "rm -rf /tmp/build-cache",
          cwd: "/app",
          decisions: [
            { intent: "approve", value: "approve" },
            { intent: "deny", value: "deny" },
          ],
          itemId: "item-1",
          kind: "approval",
          message: "Clean stale build artifacts",
          requestId: "approval-1",
          requestKind: "command_execution",
          turnId: "turn-1",
        },
        user_id: "cleanup",
      },
      phase: "waiting_for_approval",
    })
    const userInputSnapshot = runSnapshot({
      active_interaction: {
        created_at: "2026-03-15T10:01:00.000Z",
        interaction_id: "question-1",
        kind: "user_input",
        node_path: "/1",
        request: {
          itemId: "item-1",
          kind: "user_input",
          questions: [
            {
              header: "Workspace",
              id: "workspace",
              isOther: false,
              isSecret: false,
              options: null,
              question: "Which workspace should be used?",
            },
            {
              header: "Mode",
              id: "mode",
              isOther: false,
              isSecret: false,
              options: [
                { description: "Fast path", label: "quick" },
                { description: "Full path", label: "full" },
              ],
              question: "Choose the execution mode.",
            },
          ],
          requestId: "question-1",
          turnId: "turn-1",
        },
        user_id: "setup",
      },
      phase: "waiting_for_question",
    })
    const elicitationSnapshot = runSnapshot({
      active_interaction: {
        created_at: "2026-03-15T10:01:00.000Z",
        interaction_id: "elicitation-1",
        kind: "elicitation",
        node_path: "/1",
        request: {
          itemId: null,
          kind: "elicitation",
          message: "Confirm deployment target",
          mode: "form",
          requestId: "elicitation-1",
          requestedSchema: {
            properties: {
              environment: { type: "string" },
            },
            type: "object",
          },
          serverName: "codex",
          turnId: "turn-1",
        },
        user_id: "deploy",
      },
      phase: "waiting_for_interaction",
    })

    const approvalFrame = renderTerminalFrame({
      lastCompletedNodePath: null,
      liveOutputs: {},
      snapshot: approvalSnapshot,
    })
    expect(approvalFrame).toContain("Status   : waiting (approval)")
    expect(approvalFrame).toContain("Approve: rm -rf /tmp/build-cache")
    expect(approvalFrame).toContain("  reason: Clean stale build artifacts")
    expect(approvalFrame).toContain("[y]approve  [n]deny")

    const userInputFrame = renderTerminalFrame(
      {
        lastCompletedNodePath: null,
        liveOutputs: {},
        snapshot: userInputSnapshot,
      },
      { userInputQuestionIndex: 1 },
    )
    expect(userInputFrame).toContain("Status   : waiting")
    expect(userInputFrame).toContain("Question 2/2: Mode")
    expect(userInputFrame).toContain("Choose the execution mode.")
    expect(userInputFrame).toContain("  1. quick")
    expect(userInputFrame).toContain("Answer:")

    const elicitationFrame = renderTerminalFrame({
      lastCompletedNodePath: null,
      liveOutputs: {},
      snapshot: elicitationSnapshot,
    })
    expect(elicitationFrame).toContain("Request: Confirm deployment target")
    expect(elicitationFrame).toContain('  schema: {"properties":{"environment":{"type":"string"}},"type":"object"}')
    expect(elicitationFrame).toContain("[a]ccept  [d]eny  [c]cancel")
  })

  test("renders the last completed step when the run finishes", () => {
    const firstNode = nodeSnapshot({
      node_path: "/0",
      stdout: "First step\n",
      user_id: "first-step",
    })
    const secondNode = nodeSnapshot({
      duration_ms: 12300,
      node_path: "/1",
      stdout: "Applied 3 migrations.\nDatabase schema is up to date.\n",
      user_id: "run-migrations",
    })
    const runningSnapshot = runSnapshot({
      nodes: [firstNode],
    })
    const afterSecondSnapshot = runSnapshot({
      nodes: [firstNode, secondNode],
    })
    const finishedSnapshot = runSnapshot({
      finished_at: "2026-03-15T10:02:00.000Z",
      nodes: [firstNode, secondNode],
      phase: "completed",
      reason: "completed",
      status: "succeeded",
    })
    const state = createTerminalUiState()

    applyRunEvent(state, { kind: "run_started", snapshot: runningSnapshot })
    applyRunEvent(state, { kind: "node_completed", node: firstNode, snapshot: runningSnapshot })
    applyRunEvent(state, { kind: "node_completed", node: secondNode, snapshot: afterSecondSnapshot })
    applyRunEvent(state, { kind: "run_finished", snapshot: finishedSnapshot })

    const frame = renderTerminalFrame(state)
    expect(frame).toContain("Status   : succeeded")
    expect(frame).toContain("--- run-migrations (succeeded, exit 0, 12.3s) ---")
    expect(frame).toContain("  Applied 3 migrations.")
    expect(frame).toContain("Run finished.")
    expect(frame).not.toContain("--- first-step")
  })

  test("uses an explicit non-interactive control policy", async () => {
    const session = createNonInteractiveRunSession()
    const snapshot = runSnapshot()

    await expect(
      session.handle({
        barrier: {
          barrier_id: "barrier-1",
          completed: null,
          created_at: "2026-03-15T10:01:00.000Z",
          frame_id: "root",
          next: [],
          reason: "run_started",
        },
        kind: "step_barrier",
        signal: new AbortController().signal,
        snapshot,
      }),
    ).resolves.toEqual({ action: "continue", kind: "step_barrier" })

    await expect(
      session.handle({
        interaction: {
          created_at: "2026-03-15T10:01:00.000Z",
          interaction_id: "approval-1",
          kind: "approval",
          node_path: "/1",
          request: {
            command: "git push",
            cwd: "/app",
            decisions: [
              { intent: "approve", value: "approve" },
              { intent: "deny", value: "deny" },
            ],
            itemId: "item-1",
            kind: "approval",
            message: "Ship the release",
            requestId: "approval-1",
            requestKind: "command_execution",
            turnId: "turn-1",
          },
          user_id: "release",
        },
        kind: "interaction",
        signal: new AbortController().signal,
        snapshot,
      }),
    ).rejects.toThrow("workflow requires operator interaction (approval)")
  })
})
