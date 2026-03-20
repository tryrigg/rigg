import { describe, expect, test } from "bun:test"

import type { WorkflowDocument } from "../../src/workflow/schema"
import { createInkSession, createNonInteractive, createRenderOptions } from "../../src/cli/session"
import { runSnapshot } from "../fixture/builders"

describe("cli/session", () => {
  test("uses an explicit non-interactive control policy", async () => {
    const session = createNonInteractive()
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

    expect(createRenderOptions(terminal)).toMatchObject({
      exitOnCtrlC: false,
      stderr: terminal.stderr,
      stdin: terminal.stdin,
      stdout: terminal.stderr,
    })
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

    const session = createInkSession({
      barrierMode: "manual",
      interrupt: () => {
        interrupted += 1
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

  test("ink run session auto-continues barriers but still waits on interactions", async () => {
    const workflow: WorkflowDocument = { id: "wf", steps: [] }
    const terminal = {
      stderr: { isTTY: true } as unknown as NodeJS.WriteStream,
      stdin: { isTTY: true } as unknown as NodeJS.ReadStream,
    }
    let renderedTree: any

    const session = createInkSession({
      barrierMode: "auto_continue",
      interrupt: () => {},
      renderApp: ((tree: unknown) => {
        renderedTree = tree
        return { unmount: () => {} } as any
      }) as any,
      terminal,
      workflow,
    })

    expect(
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
        snapshot: runSnapshot(),
      }),
    ).toEqual({ action: "continue", kind: "step_barrier" })

    const pending = session.handle({
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
      snapshot: runSnapshot(),
    })

    renderedTree?.props.onResolveInteraction("approval-1", { decision: "approve", kind: "approval" })

    await expect(pending).resolves.toEqual({ decision: "approve", kind: "approval" })
    session.close()
  })

  test("ink run session resolves empty user_input interactions immediately", async () => {
    const workflow: WorkflowDocument = { id: "wf", steps: [] }
    const terminal = {
      stderr: { isTTY: true } as unknown as NodeJS.WriteStream,
      stdin: { isTTY: true } as unknown as NodeJS.ReadStream,
    }

    const session = createInkSession({
      barrierMode: "manual",
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

    const session = createInkSession({
      barrierMode: "manual",
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

    const session = createInkSession({
      barrierMode: "manual",
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
