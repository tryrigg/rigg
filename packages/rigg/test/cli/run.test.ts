import { describe, expect, test } from "bun:test"

import type { WorkflowDocument } from "../../src/compile/schema"
import {
  applyRunEvent,
  createControlResolverRegistry,
  createInkRenderOptions,
  createInkRunSession,
  createNonInteractiveRunSession,
  createTerminalUiState,
  previewNodeOutput,
} from "../../src/cli/run"
import { runSnapshot } from "../fixture/builders"

describe("cli/run", () => {
  test("applyRunEvent updates snapshot on run_started", () => {
    const state = createTerminalUiState()
    const snapshot = runSnapshot()
    applyRunEvent(state, { kind: "run_started", snapshot })
    expect(state.snapshot).toBe(snapshot)
    expect(state.lastCompletedNodePath).toBeNull()
  })

  test("applyRunEvent does not allocate live output buckets before output arrives", () => {
    const state = createTerminalUiState()
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

    applyRunEvent(state, { kind: "run_started", snapshot })
    applyRunEvent(state, {
      kind: "node_started",
      node: snapshot.nodes[0]!,
      snapshot,
    })
    expect(state.liveOutputs["/0"]).toBeUndefined()

    const completedNode = { ...snapshot.nodes[0]!, status: "succeeded" as const, duration_ms: 1000 }
    applyRunEvent(state, {
      kind: "node_completed",
      node: completedNode,
      snapshot: runSnapshot({ nodes: [completedNode] }),
    })
    expect(state.liveOutputs["/0"]).toBeUndefined()
    expect(state.lastCompletedNodePath).toBe("/0")
  })

  test("applyRunEvent accumulates step_output chunks", () => {
    const state = createTerminalUiState()
    const snapshot = runSnapshot()
    applyRunEvent(state, { kind: "run_started", snapshot })
    applyRunEvent(state, {
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

    applyRunEvent(state, {
      chunk: "hello ",
      kind: "step_output",
      node_path: "/0",
      stream: "stdout",
      user_id: "step-1",
    })
    applyRunEvent(state, {
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

  test("applyRunEvent keeps stdout and stderr chunks in separate entries", () => {
    const state = createTerminalUiState()
    const snapshot = runSnapshot()
    applyRunEvent(state, { kind: "run_started", snapshot })
    applyRunEvent(state, {
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

    applyRunEvent(state, {
      chunk: "hello",
      kind: "step_output",
      node_path: "/0",
      stream: "stdout",
      user_id: "step-1",
    })
    applyRunEvent(state, {
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

  test("applyRunEvent keeps stderr previews for stderr-only failures", () => {
    const state = createTerminalUiState()
    const snapshot = runSnapshot()
    applyRunEvent(state, { kind: "run_started", snapshot })
    applyRunEvent(state, {
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

    applyRunEvent(state, {
      kind: "node_completed",
      node: failedNode,
      snapshot: runSnapshot({ nodes: [failedNode] }),
    })

    expect(state.completedOutputs["/0"]?.preview).toEqual({
      stream: "stderr",
      text: "permission denied",
    })
  })

  test("previewNodeOutput prefers stderr for failed nodes and stdout for succeeded nodes", () => {
    expect(
      previewNodeOutput({
        status: "failed",
        stderr: "permission denied",
        stdout: "partial output",
      }),
    ).toEqual({
      stream: "stderr",
      text: "permission denied",
    })

    expect(
      previewNodeOutput({
        status: "succeeded",
        stderr: "warning",
        stdout: "done",
      }),
    ).toEqual({
      stream: "stdout",
      text: "done",
    })
  })

  test("previewNodeOutput prefers stderr for interrupted nodes", () => {
    expect(
      previewNodeOutput({
        status: "interrupted",
        stderr: "cancelled by sibling failure",
        stdout: "partial output",
      }),
    ).toEqual({
      stream: "stderr",
      text: "cancelled by sibling failure",
    })
  })

  test("previewNodeOutput keeps the latest lines for long output", () => {
    expect(
      previewNodeOutput({
        status: "failed",
        stderr: "line 1\nline 2\nline 3\nline 4",
      }),
    ).toEqual({
      stream: "stderr",
      text: "... +1 earlier lines\nline 2\nline 3\nline 4",
    })
  })

  test("applyRunEvent clears live outputs on run_finished", () => {
    const state = createTerminalUiState()
    const snapshot = runSnapshot()
    applyRunEvent(state, { kind: "run_started", snapshot })
    applyRunEvent(state, {
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
    applyRunEvent(state, { kind: "run_finished", snapshot: finishedSnapshot })
    expect(Object.keys(state.liveOutputs).length).toBe(0)
    expect(state.snapshot?.status).toBe("succeeded")
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

  test("routes interactive ink output to stderr and disables Ink Ctrl+C exits", () => {
    const terminal = {
      stderr: { isTTY: true } as unknown as NodeJS.WriteStream,
      stdin: { isTTY: true } as unknown as NodeJS.ReadStream,
    }

    expect(createInkRenderOptions(terminal)).toMatchObject({
      exitOnCtrlC: false,
      stderr: terminal.stderr,
      stdin: terminal.stdin,
      stdout: terminal.stderr,
    })
  })

  test("control resolver registry rejects stale requests when the signal aborts", async () => {
    const registry = createControlResolverRegistry()
    const controller = new AbortController()

    const pending = registry.register({
      barrier: {
        barrier_id: "barrier-1",
        completed: null,
        created_at: "2026-03-15T10:01:00.000Z",
        frame_id: "root",
        next: [],
        reason: "run_started",
      },
      kind: "step_barrier",
      signal: controller.signal,
      snapshot: runSnapshot(),
    })

    controller.abort(new Error("stale barrier"))

    await expect(pending).rejects.toThrow("stale barrier")
  })

  test("control resolver registry preserves aborts that land during listener setup", async () => {
    const registry = createControlResolverRegistry()
    const controller = new AbortController()
    const originalAddEventListener = AbortSignal.prototype.addEventListener

    AbortSignal.prototype.addEventListener = function (
      this: AbortSignal,
      type: string,
      listener: any,
      options?: AddEventListenerOptions | boolean,
    ): void {
      if (this === controller.signal && type === "abort" && !controller.signal.aborted) {
        controller.abort(new Error("stale barrier"))
      }
      return originalAddEventListener.call(this, type, listener, options)
    }

    try {
      const pending = registry.register({
        barrier: {
          barrier_id: "barrier-1",
          completed: null,
          created_at: "2026-03-15T10:01:00.000Z",
          frame_id: "root",
          next: [],
          reason: "run_started",
        },
        kind: "step_barrier",
        signal: controller.signal,
        snapshot: runSnapshot(),
      })

      await expect(pending).rejects.toThrow("stale barrier")
    } finally {
      AbortSignal.prototype.addEventListener = originalAddEventListener
    }
  })

  test("ink run session resolves controls through the resolver registry", async () => {
    const workflow: WorkflowDocument = { id: "wf", steps: [] }
    const terminal = {
      stderr: { isTTY: true } as unknown as NodeJS.WriteStream,
      stdin: { isTTY: true } as unknown as NodeJS.ReadStream,
    }
    let renderedTree: any
    let unmounted = false
    let interrupted = 0

    const session = createInkRunSession({
      interrupt: () => {
        interrupted++
      },
      renderApp: ((tree: unknown) => {
        renderedTree = tree
        return {
          unmount: () => {
            unmounted = true
          },
        } as any
      }) as any,
      terminal,
      workflow,
    })

    const pending = session.handle({
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
      snapshot: runSnapshot(),
    })

    renderedTree?.props.onInterrupt()
    renderedTree?.props.onResolveBarrier("barrier-1", "continue")

    await expect(pending).resolves.toEqual({ action: "continue", kind: "step_barrier" })

    expect(interrupted).toBe(1)
    session.close()
    expect(unmounted).toBe(true)
  })

  test("ink run session resolves empty user_input interactions immediately", async () => {
    const workflow: WorkflowDocument = { id: "wf", steps: [] }
    const terminal = {
      stderr: { isTTY: true } as unknown as NodeJS.WriteStream,
      stdin: { isTTY: true } as unknown as NodeJS.ReadStream,
    }

    const session = createInkRunSession({
      interrupt: () => {},
      renderApp: (() => ({ unmount: () => {} })) as any,
      terminal,
      workflow,
    })

    expect(
      session.handle({
        interaction: {
          created_at: "2026-03-15T10:01:00.000Z",
          interaction_id: "question-1",
          kind: "user_input",
          node_path: "/1",
          request: {
            itemId: "item-1",
            kind: "user_input",
            questions: [],
            requestId: "question-1",
            turnId: "turn-1",
          },
          user_id: "release",
        },
        kind: "interaction",
        signal: new AbortController().signal,
        snapshot: runSnapshot(),
      }),
    ).toEqual({
      answers: {},
      kind: "user_input",
    })

    session.close()
  })

  test("ink run session renders a standalone pre-run interaction and clears it after resolution", async () => {
    const workflow: WorkflowDocument = { id: "wf", steps: [] }
    const terminal = {
      stderr: { isTTY: true } as unknown as NodeJS.WriteStream,
      stdin: { isTTY: true } as unknown as NodeJS.ReadStream,
    }
    let renderedTree: any

    const session = createInkRunSession({
      interrupt: () => {},
      renderApp: ((tree: unknown) => {
        renderedTree = tree
        return { unmount: () => {} } as any
      }) as any,
      terminal,
      workflow,
    })

    const pending = session.handle({
      interaction: {
        created_at: "2026-03-15T10:01:00.000Z",
        interaction_id: "question-1",
        kind: "user_input",
        node_path: null,
        request: {
          itemId: "item-1",
          kind: "user_input",
          questions: [
            {
              header: "name",
              id: "name",
              isOther: false,
              isSecret: false,
              options: null,
              question: "Input: name\nType: string",
            },
          ],
          requestId: "question-1",
          turnId: "turn-1",
        },
        user_id: null,
      },
      kind: "interaction",
      signal: new AbortController().signal,
      snapshot: runSnapshot(),
    })

    expect(renderedTree?.props.store.getSnapshot().state.snapshot?.active_interaction?.interaction_id).toBe(
      "question-1",
    )
    expect(renderedTree?.props.store.getSnapshot().state.snapshot?.phase).toBe("waiting_for_question")

    renderedTree?.props.onResolveInteraction("question-1", {
      answers: { name: { answers: ["Rigg"] } },
      kind: "user_input",
    })

    await expect(pending).resolves.toEqual({
      answers: { name: { answers: ["Rigg"] } },
      kind: "user_input",
    })
    expect(renderedTree?.props.store.getSnapshot().state.snapshot?.active_interaction).toBeNull()

    session.close()
  })

  test("ink run session clears a standalone pre-run interaction when it aborts", async () => {
    const workflow: WorkflowDocument = { id: "wf", steps: [] }
    const terminal = {
      stderr: { isTTY: true } as unknown as NodeJS.WriteStream,
      stdin: { isTTY: true } as unknown as NodeJS.ReadStream,
    }
    let renderedTree: any

    const session = createInkRunSession({
      interrupt: () => {},
      renderApp: ((tree: unknown) => {
        renderedTree = tree
        return { unmount: () => {} } as any
      }) as any,
      terminal,
      workflow,
    })

    const controller = new AbortController()
    const pending = session.handle({
      interaction: {
        created_at: "2026-03-15T10:01:00.000Z",
        interaction_id: "question-1",
        kind: "user_input",
        node_path: null,
        request: {
          itemId: "item-1",
          kind: "user_input",
          questions: [
            {
              header: "name",
              id: "name",
              isOther: false,
              isSecret: false,
              options: null,
              question: "Input: name\nType: string",
            },
          ],
          requestId: "question-1",
          turnId: "turn-1",
        },
        user_id: null,
      },
      kind: "interaction",
      signal: controller.signal,
      snapshot: runSnapshot(),
    })

    expect(renderedTree?.props.store.getSnapshot().state.snapshot?.active_interaction?.interaction_id).toBe(
      "question-1",
    )

    controller.abort(new Error("pre-run prompt aborted"))

    await expect(pending).rejects.toThrow("pre-run prompt aborted")
    expect(renderedTree?.props.store.getSnapshot().state.snapshot?.active_interaction).toBeNull()

    session.close()
  })
})
