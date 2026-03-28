import { describe, expect, test } from "bun:test"

import { applyEvent, createState, previewOutput } from "../../src/cli/state"
import type { NodeSnapshot } from "../../src/session/schema"
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

    const failedNode: NodeSnapshot = {
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

  test("applyEvent tracks retrying state until the next attempt starts", () => {
    const state = createState()
    const snapshot = runSnapshot()
    applyEvent(state, { kind: "run_started", snapshot })
    const initialRetrying = state.retryingByNodePath
    applyEvent(state, {
      attempt: 1,
      delay_ms: 1000,
      kind: "node_retrying",
      max_attempts: 3,
      next_attempt: 2,
      node_path: "/0",
      previous_attempts: [
        {
          attempt: 1,
          exit_code: 1,
          message: "boom",
          stderr: "boom",
        },
      ],
      user_id: "retry",
    })

    expect(state.retryingByNodePath).not.toBe(initialRetrying)
    expect(state.retryingByNodePath["/0"]).toEqual({
      attempt: 1,
      delayMs: 1000,
      maxAttempts: 3,
      previousAttempts: [
        {
          attempt: 1,
          exit_code: 1,
          message: "boom",
          stderr: "boom",
        },
      ],
      userId: "retry",
    })

    applyEvent(state, {
      kind: "node_started",
      node: {
        attempt: 2,
        duration_ms: null,
        exit_code: null,
        finished_at: null,
        node_kind: "shell",
        node_path: "/0",
        result: null,
        started_at: "2026-03-15T10:00:01.000Z",
        status: "running",
        stderr: null,
        stdout: null,
        user_id: "retry",
        waiting_for: null,
      },
      snapshot,
    })

    expect(state.retryingByNodePath).toEqual({})
    expect(state.retryingByNodePath["/0"]).toBeUndefined()
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

  test("applyEvent renders claude provider events in live output", () => {
    const state = createState()
    const snapshot = runSnapshot()
    applyEvent(state, { kind: "run_started", snapshot })
    applyEvent(state, {
      kind: "provider_event",
      event: {
        kind: "message_delta",
        messageId: "msg_claude",
        provider: "claude",
        sessionId: "session_1",
        text: "hello",
      },
      node_path: "/0",
      user_id: "claude-step",
    })
    applyEvent(state, {
      kind: "provider_event",
      event: {
        detail: "npm test",
        kind: "tool_started",
        provider: "claude",
        sessionId: "session_1",
        tool: "Bash",
      },
      node_path: "/0",
      user_id: "claude-step",
    })
    applyEvent(state, {
      kind: "provider_event",
      event: {
        kind: "error",
        message: "permission denied",
        provider: "claude",
        sessionId: "session_1",
      },
      node_path: "/0",
      user_id: "claude-step",
    })

    expect(state.liveOutputs["/0"]?.entries).toEqual([
      {
        key: "msg_claude",
        text: "hello",
        variant: "assistant",
      },
      {
        key: null,
        text: "tool started: Bash (npm test)",
        variant: "event",
      },
      {
        key: null,
        text: "error: permission denied",
        variant: "event",
      },
    ])
  })

  test("applyEvent keeps OpenCode text parts separate within one message", () => {
    const state = createState()
    const snapshot = runSnapshot()
    applyEvent(state, { kind: "run_started", snapshot })
    applyEvent(state, {
      kind: "provider_event",
      event: {
        kind: "message_delta",
        messageId: "msg_1",
        partId: "part_1",
        provider: "opencode",
        sessionId: "session_1",
        text: "Hello",
      },
      node_path: "/0",
      user_id: "opencode-step",
    })
    applyEvent(state, {
      kind: "provider_event",
      event: {
        kind: "message_completed",
        messageId: "msg_1",
        partId: "part_1",
        provider: "opencode",
        sessionId: "session_1",
        text: "Hello",
      },
      node_path: "/0",
      user_id: "opencode-step",
    })
    applyEvent(state, {
      kind: "provider_event",
      event: {
        kind: "message_delta",
        messageId: "msg_1",
        partId: "part_2",
        provider: "opencode",
        sessionId: "session_1",
        text: "After tool",
      },
      node_path: "/0",
      user_id: "opencode-step",
    })
    applyEvent(state, {
      kind: "provider_event",
      event: {
        kind: "message_completed",
        messageId: "msg_1",
        partId: "part_2",
        provider: "opencode",
        sessionId: "session_1",
        text: "After tool",
      },
      node_path: "/0",
      user_id: "opencode-step",
    })

    expect(state.liveOutputs["/0"]?.entries).toEqual([
      {
        key: "session_1:part_1",
        text: "Hello",
        variant: "assistant",
      },
      {
        key: "session_1:part_2",
        text: "After tool",
        variant: "assistant",
      },
    ])
  })

  test("applyEvent scopes OpenCode text parts by session", () => {
    const state = createState()
    const snapshot = runSnapshot()
    applyEvent(state, { kind: "run_started", snapshot })
    applyEvent(state, {
      kind: "provider_event",
      event: {
        kind: "message_delta",
        messageId: "msg_1",
        partId: "part_1",
        provider: "opencode",
        sessionId: "session_1",
        text: "Alpha",
      },
      node_path: "/0",
      user_id: "opencode-step",
    })
    applyEvent(state, {
      kind: "provider_event",
      event: {
        kind: "message_delta",
        messageId: "msg_2",
        partId: "part_1",
        provider: "opencode",
        sessionId: "session_2",
        text: "Beta",
      },
      node_path: "/0",
      user_id: "opencode-step",
    })

    expect(state.liveOutputs["/0"]?.entries).toEqual([
      {
        key: "session_1:part_1",
        text: "Alpha",
        variant: "assistant",
      },
      {
        key: "session_2:part_1",
        text: "Beta",
        variant: "assistant",
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
    const completedNode: NodeSnapshot = {
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
            detail: "echo hi",
            frame_id: "root",
            node_kind: "shell",
            node_path: "/1",
            user_id: "draft_shell",
          },
          {
            collaboration_mode: "plan",
            cwd: "/workspace",
            detail: "codex turn · plan",
            frame_id: "root",
            kind: "turn",
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
        waiting: {
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
                detail: "echo hi",
                frame_id: "root",
                node_kind: "shell",
                node_path: "/1",
                user_id: "draft_shell",
              },
              {
                collaboration_mode: "plan",
                cwd: "/workspace",
                detail: "codex turn · plan",
                frame_id: "root",
                kind: "turn",
                model: "gpt-5.4",
                node_kind: "codex",
                node_path: "/2",
                prompt_preview: "Draft a plan",
                user_id: "draft_plan",
              },
            ],
            reason: "step_completed",
          },
          kind: "barrier",
        },
        nodes: [completedNode],
      }),
    })

    expect(state.completedOutputs["/0"]?.entries.at(-1)).toEqual({
      key: null,
      text: "auto-continue: Next: draft_shell [cmd], draft_plan [codex] · turn · plan · gpt-5.4",
      variant: "event",
    })
  })

  test("applyEvent includes cursor model in auto-continue frontier labels", () => {
    const state = createState("auto_continue")
    const completedNode: NodeSnapshot = {
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
            cwd: "/workspace",
            detail: "cursor ask",
            frame_id: "root",
            model: "composer-2",
            mode: "ask",
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
        waiting: {
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
                cwd: "/workspace",
                detail: "cursor ask",
                frame_id: "root",
                model: "composer-2",
                mode: "ask",
                node_kind: "cursor",
                node_path: "/1",
                prompt_preview: "Question?",
                user_id: "draft_cursor",
              },
            ],
            reason: "step_completed",
          },
          kind: "barrier",
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

  test("applyEvent includes claude model in auto-continue frontier labels", () => {
    const state = createState("auto_continue")
    const completedNode: NodeSnapshot = {
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
            cwd: "/workspace",
            detail: "claude",
            frame_id: "root",
            model: "claude-opus-4-6",
            node_kind: "claude",
            node_path: "/1",
            prompt_preview: "Implement the change",
            user_id: "draft_claude",
          },
        ],
        reason: "step_completed",
      },
      kind: "barrier_reached",
      snapshot: runSnapshot({
        waiting: {
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
                cwd: "/workspace",
                detail: "claude",
                frame_id: "root",
                model: "claude-opus-4-6",
                node_kind: "claude",
                node_path: "/1",
                prompt_preview: "Implement the change",
                user_id: "draft_claude",
              },
            ],
            reason: "step_completed",
          },
          kind: "barrier",
        },
        nodes: [completedNode],
      }),
    })

    expect(state.completedOutputs["/0"]?.entries.at(-1)).toEqual({
      key: null,
      text: "auto-continue: Next: draft_claude [claude] · claude-opus-4-6",
      variant: "event",
    })
  })

  test("applyEvent leaves manual barriers unchanged", () => {
    const state = createState("manual")
    const completedNode: NodeSnapshot = {
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
            detail: "echo hi",
            frame_id: "root",
            node_kind: "shell",
            node_path: "/1",
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
