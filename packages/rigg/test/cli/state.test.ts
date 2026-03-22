import { describe, expect, test } from "bun:test"

import { applyEvent, createState, previewOutput } from "../../src/cli/state"
import { runSnapshot } from "../fixture/builders"

describe("cli/state", () => {
  test("applyEvent updates snapshot on run_started", () => {
    const state = createState()
    const snapshot = runSnapshot()
    applyEvent(state, { kind: "run_started", snapshot })
    expect(state.snapshot).toBe(snapshot)
    expect(state.lastCompletedNodePath).toBeNull()
  })

  test("applyEvent does not allocate live output buckets before output arrives", () => {
    const state = createState()
    const snapshot = runSnapshot({
      nodes: [
        {
          attempt: 1,
          duration_ms: null,
          exit_code: null,
          finished_at: null,
          node_kind: "shell",
          node_path: "/0",
          result: null,
          started_at: "2026-03-15T10:00:00.000Z",
          status: "running",
          stderr: null,
          stdout: null,
          user_id: "step-1",
          waiting_for: null,
        },
      ],
    })

    applyEvent(state, { kind: "run_started", snapshot })
    applyEvent(state, {
      kind: "node_started",
      node: snapshot.nodes[0]!,
      snapshot,
    })
    expect(state.liveOutputs["/0"]).toBeUndefined()

    const completedNode = { ...snapshot.nodes[0]!, status: "succeeded" as const, duration_ms: 1000 }
    applyEvent(state, {
      kind: "node_completed",
      node: completedNode,
      snapshot: runSnapshot({ nodes: [completedNode] }),
    })
    expect(state.liveOutputs["/0"]).toBeUndefined()
    expect(state.lastCompletedNodePath).toBe("/0")
  })

  test("applyEvent accumulates step_output chunks", () => {
    const state = createState()
    const snapshot = runSnapshot()
    applyEvent(state, { kind: "run_started", snapshot })
    applyEvent(state, {
      kind: "node_started",
      node: {
        attempt: 1,
        duration_ms: null,
        exit_code: null,
        finished_at: null,
        node_kind: "shell",
        node_path: "/0",
        result: null,
        started_at: "2026-03-15T10:00:00.000Z",
        status: "running",
        stderr: null,
        stdout: null,
        user_id: "step-1",
        waiting_for: null,
      },
      snapshot,
    })

    applyEvent(state, {
      chunk: "hello ",
      kind: "step_output",
      node_path: "/0",
      stream: "stdout",
      user_id: "step-1",
    })
    applyEvent(state, {
      chunk: "world",
      kind: "step_output",
      node_path: "/0",
      stream: "stdout",
      user_id: "step-1",
    })

    const entries = state.liveOutputs["/0"]?.entries ?? []
    expect(entries.length).toBe(1)
    expect(entries[0]?.text).toBe("hello world")
    expect(entries[0]?.stream).toBe("stdout")
  })

  test("applyEvent keeps stdout and stderr chunks in separate entries", () => {
    const state = createState()
    const snapshot = runSnapshot()
    applyEvent(state, { kind: "run_started", snapshot })
    applyEvent(state, {
      kind: "node_started",
      node: {
        attempt: 1,
        duration_ms: null,
        exit_code: null,
        finished_at: null,
        node_kind: "shell",
        node_path: "/0",
        result: null,
        started_at: "2026-03-15T10:00:00.000Z",
        status: "running",
        stderr: null,
        stdout: null,
        user_id: "step-1",
        waiting_for: null,
      },
      snapshot,
    })

    applyEvent(state, {
      chunk: "hello",
      kind: "step_output",
      node_path: "/0",
      stream: "stdout",
      user_id: "step-1",
    })
    applyEvent(state, {
      chunk: "permission denied",
      kind: "step_output",
      node_path: "/0",
      stream: "stderr",
      user_id: "step-1",
    })

    expect(state.liveOutputs["/0"]?.entries).toEqual([
      {
        key: null,
        stream: "stdout",
        text: "hello",
        variant: "stream",
      },
      {
        key: null,
        stream: "stderr",
        text: "permission denied",
        variant: "stream",
      },
    ])
  })

  test("applyEvent keeps stderr previews for stderr-only failures", () => {
    const state = createState()
    const snapshot = runSnapshot()
    applyEvent(state, { kind: "run_started", snapshot })
    applyEvent(state, {
      kind: "node_started",
      node: {
        attempt: 1,
        duration_ms: null,
        exit_code: null,
        finished_at: null,
        node_kind: "write_file",
        node_path: "/0",
        result: null,
        started_at: "2026-03-15T10:00:00.000Z",
        status: "running",
        stderr: null,
        stdout: null,
        user_id: "step-1",
        waiting_for: null,
      },
      snapshot,
    })

    const failedNode = {
      attempt: 1,
      duration_ms: 15,
      exit_code: 1,
      finished_at: "2026-03-15T10:00:00.015Z",
      node_kind: "write_file",
      node_path: "/0",
      result: null,
      started_at: "2026-03-15T10:00:00.000Z",
      status: "failed" as const,
      stderr: "permission denied",
      stdout: null,
      user_id: "step-1",
      waiting_for: null,
    }

    applyEvent(state, {
      kind: "node_completed",
      node: failedNode,
      snapshot: runSnapshot({ nodes: [failedNode] }),
    })

    expect(state.completedOutputs["/0"]?.preview).toEqual({
      stream: "stderr",
      text: "permission denied",
    })
  })

  test("applyEvent renders cursor provider events in live output", () => {
    const state = createState()
    const snapshot = runSnapshot()
    applyEvent(state, { kind: "run_started", snapshot })
    applyEvent(state, {
      kind: "provider_event",
      event: {
        kind: "message_delta",
        messageId: "msg_1",
        provider: "cursor",
        sessionId: "session_1",
        text: "hello",
      },
      node_path: "/0",
      user_id: "cursor-step",
    })
    applyEvent(state, {
      kind: "provider_event",
      event: {
        kind: "diagnostic",
        message: "permission pending",
        provider: "cursor",
        sessionId: "session_1",
      },
      node_path: "/0",
      user_id: "cursor-step",
    })

    expect(state.liveOutputs["/0"]?.entries).toEqual([
      {
        key: "msg_1",
        text: "hello",
        variant: "assistant",
      },
      {
        key: null,
        text: "diagnostic: permission pending",
        variant: "event",
      },
    ])
  })

  test("previewOutput prefers stderr for failed nodes and stdout for succeeded nodes", () => {
    expect(
      previewOutput({
        status: "failed",
        stderr: "permission denied",
        stdout: "partial output",
      }),
    ).toEqual({
      stream: "stderr",
      text: "permission denied",
    })

    expect(
      previewOutput({
        status: "succeeded",
        stderr: "warning",
        stdout: "done",
      }),
    ).toEqual({
      stream: "stdout",
      text: "done",
    })
  })

  test("previewOutput prefers stderr for interrupted nodes", () => {
    expect(
      previewOutput({
        status: "interrupted",
        stderr: "cancelled by sibling failure",
        stdout: "partial output",
      }),
    ).toEqual({
      stream: "stderr",
      text: "cancelled by sibling failure",
    })
  })

  test("previewOutput keeps the latest lines for long output", () => {
    expect(
      previewOutput({
        status: "failed",
        stderr: "line 1\nline 2\nline 3\nline 4",
      }),
    ).toEqual({
      stream: "stderr",
      text: "... +1 earlier lines\nline 2\nline 3\nline 4",
    })
  })

  test("applyEvent clears live outputs on run_finished", () => {
    const state = createState()
    const snapshot = runSnapshot()
    applyEvent(state, { kind: "run_started", snapshot })
    applyEvent(state, {
      kind: "node_started",
      node: {
        attempt: 1,
        duration_ms: null,
        exit_code: null,
        finished_at: null,
        node_kind: "shell",
        node_path: "/0",
        result: null,
        started_at: "2026-03-15T10:00:00.000Z",
        status: "running",
        stderr: null,
        stdout: null,
        user_id: null,
        waiting_for: null,
      },
      snapshot,
    })

    const finishedSnapshot = runSnapshot({ status: "succeeded", phase: "completed" })
    applyEvent(state, { kind: "run_finished", snapshot: finishedSnapshot })
    expect(Object.keys(state.liveOutputs).length).toBe(0)
    expect(state.snapshot?.status).toBe("succeeded")
  })

  test("applyEvent appends an auto-continue event for completed barriers", () => {
    const state = createState("auto_continue")
    const completedNode = {
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
      stdout: "repo ready\n",
      user_id: "collect_context",
      waiting_for: null,
    }
    const completedSnapshot = runSnapshot({ nodes: [completedNode] })

    applyEvent(state, { kind: "run_started", snapshot: completedSnapshot })
    applyEvent(state, {
      kind: "node_completed",
      node: completedNode,
      snapshot: completedSnapshot,
    })
    applyEvent(state, {
      barrier: {
        barrier_id: "barrier-1",
        completed: {
          node_kind: "shell",
          node_path: "/0",
          result: null,
          status: "succeeded",
          user_id: "collect_context",
        },
        created_at: "2026-03-15T10:01:01.000Z",
        frame_id: "root",
        next: [
          {
            action: null,
            cwd: null,
            detail: "echo hi",
            frame_id: "root",
            model: null,
            node_kind: "shell",
            node_path: "/1",
            prompt_preview: null,
            user_id: "draft_shell",
          },
          {
            action: "plan",
            cwd: "/workspace",
            detail: "codex plan",
            frame_id: "root",
            model: "gpt-5.4",
            node_kind: "codex",
            node_path: "/2",
            prompt_preview: "Draft a plan",
            user_id: "draft_plan",
          },
        ],
        reason: "step_completed",
      },
      kind: "barrier_reached",
      snapshot: runSnapshot({
        active_barrier: {
          barrier_id: "barrier-1",
          completed: {
            node_kind: "shell",
            node_path: "/0",
            result: null,
            status: "succeeded",
            user_id: "collect_context",
          },
          created_at: "2026-03-15T10:01:01.000Z",
          frame_id: "root",
          next: [
            {
              action: null,
              cwd: null,
              detail: "echo hi",
              frame_id: "root",
              model: null,
              node_kind: "shell",
              node_path: "/1",
              prompt_preview: null,
              user_id: "draft_shell",
            },
            {
              action: "plan",
              cwd: "/workspace",
              detail: "codex plan",
              frame_id: "root",
              model: "gpt-5.4",
              node_kind: "codex",
              node_path: "/2",
              prompt_preview: "Draft a plan",
              user_id: "draft_plan",
            },
          ],
          reason: "step_completed",
        },
        nodes: [completedNode],
      }),
    })

    expect(state.completedOutputs["/0"]?.entries.at(-1)).toEqual({
      key: null,
      text: "auto-continue: Next: draft_shell [cmd], draft_plan [codex] · plan · gpt-5.4",
      variant: "event",
    })
  })

  test("applyEvent includes cursor model in auto-continue frontier labels", () => {
    const state = createState("auto_continue")
    const completedNode = {
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
      stdout: "repo ready\n",
      user_id: "collect_context",
      waiting_for: null,
    }
    const completedSnapshot = runSnapshot({ nodes: [completedNode] })

    applyEvent(state, { kind: "run_started", snapshot: completedSnapshot })
    applyEvent(state, {
      kind: "node_completed",
      node: completedNode,
      snapshot: completedSnapshot,
    })
    applyEvent(state, {
      barrier: {
        barrier_id: "barrier-1",
        completed: {
          node_kind: "shell",
          node_path: "/0",
          result: null,
          status: "succeeded",
          user_id: "collect_context",
        },
        created_at: "2026-03-15T10:01:01.000Z",
        frame_id: "root",
        next: [
          {
            action: "ask",
            cwd: "/workspace",
            detail: "cursor ask",
            frame_id: "root",
            model: "composer-2",
            node_kind: "cursor",
            node_path: "/1",
            prompt_preview: "Question?",
            user_id: "draft_cursor",
          },
        ],
        reason: "step_completed",
      },
      kind: "barrier_reached",
      snapshot: runSnapshot({
        active_barrier: {
          barrier_id: "barrier-1",
          completed: {
            node_kind: "shell",
            node_path: "/0",
            result: null,
            status: "succeeded",
            user_id: "collect_context",
          },
          created_at: "2026-03-15T10:01:01.000Z",
          frame_id: "root",
          next: [
            {
              action: "ask",
              cwd: "/workspace",
              detail: "cursor ask",
              frame_id: "root",
              model: "composer-2",
              node_kind: "cursor",
              node_path: "/1",
              prompt_preview: "Question?",
              user_id: "draft_cursor",
            },
          ],
          reason: "step_completed",
        },
        nodes: [completedNode],
      }),
    })

    expect(state.completedOutputs["/0"]?.entries.at(-1)).toEqual({
      key: null,
      text: "auto-continue: Next: draft_cursor [cursor] · ask · composer-2",
      variant: "event",
    })
  })

  test("applyEvent leaves manual barriers unchanged", () => {
    const state = createState("manual")
    const completedNode = {
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
      stdout: "repo ready\n",
      user_id: "collect_context",
      waiting_for: null,
    }
    const completedSnapshot = runSnapshot({ nodes: [completedNode] })

    applyEvent(state, { kind: "run_started", snapshot: completedSnapshot })
    applyEvent(state, {
      kind: "node_completed",
      node: completedNode,
      snapshot: completedSnapshot,
    })
    applyEvent(state, {
      barrier: {
        barrier_id: "barrier-1",
        completed: {
          node_kind: "shell",
          node_path: "/0",
          result: null,
          status: "succeeded",
          user_id: "collect_context",
        },
        created_at: "2026-03-15T10:01:01.000Z",
        frame_id: "root",
        next: [
          {
            action: null,
            cwd: null,
            detail: "echo hi",
            frame_id: "root",
            model: null,
            node_kind: "shell",
            node_path: "/1",
            prompt_preview: null,
            user_id: "draft_shell",
          },
        ],
        reason: "step_completed",
      },
      kind: "barrier_reached",
      snapshot: runSnapshot({ nodes: [completedNode] }),
    })

    expect(state.completedOutputs["/0"]?.entries).toEqual([])
  })
})
