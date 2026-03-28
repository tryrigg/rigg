import { describe, expect, test } from "bun:test"

import type { InteractionResolution } from "../../src/session/interaction"
import type { WorkflowDocument } from "../../src/workflow/schema"
import { createHeadless, createInkSession, createNonInteractive, createRenderOptions } from "../../src/cli/session"
import { runSnapshot } from "../fixture/builders"

type RenderApp = NonNullable<Parameters<typeof createInkSession>[0]["renderApp"]>
type RenderHandle = ReturnType<RenderApp>
type RenderedTree = {
  props: {
    onInterrupt: () => void
    onResolveBarrier: (barrierId: string, action: "abort" | "continue") => void
    onResolveInteraction: (interactionId: string, resolution: InteractionResolution) => void
    store: {
      getSnapshot: () => {
        state: {
          snapshot: {
            phase?: string | null
            waiting:
              | { kind: "none" }
              | { interaction: { interaction_id: string }; kind: "interaction" }
              | { barrier: { barrier_id: string }; kind: "barrier" }
          } | null
        }
      }
    }
  }
}

function stubRenderApp(
  options: {
    onRender?: ((tree: RenderedTree) => void) | undefined
    onUnmount?: (() => void) | undefined
  } = {},
): RenderApp {
  return ((tree: unknown) => {
    options.onRender?.(tree as RenderedTree)
    return { unmount: () => options.onUnmount?.() } as RenderHandle
  }) as RenderApp
}

function rendered(tree: RenderedTree | null): RenderedTree {
  if (tree === null) {
    throw new Error("expected rendered tree")
  }

  return tree
}

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

  test("headless run session resolves controls deterministically", async () => {
    const session = createHeadless()
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
              { intent: "cancel", value: "cancel" },
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
    ).resolves.toEqual({ decision: "deny", kind: "approval" })

    await expect(
      session.handle({
        interaction: {
          created_at: "2026-03-15T10:01:00.000Z",
          interaction_id: "elicitation-1",
          kind: "elicitation",
          node_path: "/1",
          request: {
            itemId: null,
            kind: "elicitation",
            message: "Need more detail",
            mode: "form",
            requestId: "elicitation-1",
            requestedSchema: {},
            serverName: "rigg",
            turnId: null,
          },
          user_id: "release",
        },
        kind: "interaction",
        signal: new AbortController().signal,
        snapshot,
      }),
    ).resolves.toEqual({ action: "decline", kind: "elicitation" })

    await expect(
      session.handle({
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
                initialValue: "Rigg",
                isOther: false,
                isSecret: false,
                options: null,
                question: "Input: name\nType: string",
              },
              {
                header: "count",
                id: "count",
                isOther: false,
                isSecret: false,
                options: null,
                question: "Input: count\nType: integer",
              },
            ],
            requestId: "question-1",
            turnId: "turn-1",
          },
          user_id: null,
        },
        kind: "interaction",
        signal: new AbortController().signal,
        snapshot,
      }),
    ).resolves.toEqual({
      answers: {
        count: { answers: [] },
        name: { answers: ["Rigg"] },
      },
      kind: "user_input",
    })

    await expect(
      session.handle({
        interaction: {
          created_at: "2026-03-15T10:01:00.000Z",
          interaction_id: "question-2",
          kind: "user_input",
          node_path: null,
          request: {
            itemId: "item-2",
            kind: "user_input",
            questions: [],
            requestId: "question-2",
            turnId: "turn-2",
          },
          user_id: null,
        },
        kind: "interaction",
        signal: new AbortController().signal,
        snapshot,
      }),
    ).resolves.toEqual({
      answers: {},
      kind: "user_input",
    })
  })

  test("headless approval falls back to the first non-approve custom decision", async () => {
    const session = createHeadless()

    await expect(
      session.handle({
        interaction: {
          created_at: "2026-03-15T10:01:00.000Z",
          interaction_id: "approval-2",
          kind: "approval",
          node_path: "/1",
          request: {
            command: null,
            cwd: null,
            decisions: [
              { intent: "approve", value: "approve" },
              { intent: null, value: "frontend" },
              { intent: null, value: "backend" },
            ],
            itemId: "item-2",
            kind: "approval",
            message: "Choose an extension target",
            requestId: "approval-2",
            requestKind: "permissions",
            turnId: "turn-2",
          },
          user_id: "release",
        },
        kind: "interaction",
        signal: new AbortController().signal,
        snapshot: runSnapshot(),
      }),
    ).resolves.toEqual({ decision: "frontend", kind: "approval" })
  })

  test("headless approval rejects approve-only decision lists", async () => {
    const session = createHeadless()

    await expect(
      session.handle({
        interaction: {
          created_at: "2026-03-15T10:01:00.000Z",
          interaction_id: "approval-3",
          kind: "approval",
          node_path: "/1",
          request: {
            command: "git push",
            cwd: "/app",
            decisions: [{ intent: "approve", value: "accept" }],
            itemId: "item-3",
            kind: "approval",
            message: "Ship the release",
            requestId: "approval-3",
            requestKind: "command_execution",
            turnId: "turn-3",
          },
          user_id: "release",
        },
        kind: "interaction",
        signal: new AbortController().signal,
        snapshot: runSnapshot(),
      }),
    ).rejects.toThrow("headless approval requires an explicit non-approve decision")
  })

  test("headless run session rejects required prompts without defaults", async () => {
    const session = createHeadless()

    await expect(
      session.handle({
        interaction: {
          created_at: "2026-03-15T10:01:00.000Z",
          interaction_id: "question-3",
          kind: "user_input",
          node_path: null,
          request: {
            itemId: "item-3",
            kind: "user_input",
            questions: [
              {
                allowEmpty: false,
                header: "prompt",
                id: "prompt",
                isOther: false,
                isSecret: false,
                options: null,
                question: "Prompt",
              },
            ],
            requestId: "question-3",
            turnId: "turn-3",
          },
          user_id: null,
        },
        kind: "interaction",
        signal: new AbortController().signal,
        snapshot: runSnapshot(),
      }),
    ).rejects.toThrow("cannot answer required prompt non-interactively (prompt)")
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
    let renderedTree: RenderedTree | null = null
    let unmounted = false
    let interrupted = 0

    const session = createInkSession({
      barrierMode: "manual",
      interrupt: () => {
        interrupted += 1
      },
      renderApp: stubRenderApp({
        onRender: (tree) => {
          renderedTree = tree
        },
        onUnmount: () => {
          unmounted = true
        },
      }),
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

    rendered(renderedTree).props.onInterrupt()
    rendered(renderedTree).props.onResolveBarrier("barrier-1", "continue")

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
    let renderedTree: RenderedTree | null = null

    const session = createInkSession({
      barrierMode: "auto_continue",
      interrupt: () => {},
      renderApp: stubRenderApp({
        onRender: (tree) => {
          renderedTree = tree
        },
      }),
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

    rendered(renderedTree).props.onResolveInteraction("approval-1", { decision: "approve", kind: "approval" })

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
      renderApp: stubRenderApp(),
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
    let renderedTree: RenderedTree | null = null

    const session = createInkSession({
      barrierMode: "manual",
      interrupt: () => {},
      renderApp: stubRenderApp({
        onRender: (tree) => {
          renderedTree = tree
        },
      }),
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

    const firstSnapshot = rendered(renderedTree).props.store.getSnapshot().state.snapshot
    expect(firstSnapshot?.waiting.kind).toBe("interaction")
    if (firstSnapshot?.waiting.kind !== "interaction") {
      throw new Error("missing interaction")
    }
    expect(firstSnapshot.waiting.interaction.interaction_id).toBe("question-1")
    expect(firstSnapshot.phase).toBe("waiting_for_question")

    rendered(renderedTree).props.onResolveInteraction("question-1", {
      answers: { name: { answers: ["Rigg"] } },
      kind: "user_input",
    })

    await expect(pending).resolves.toEqual({
      answers: { name: { answers: ["Rigg"] } },
      kind: "user_input",
    })
    expect(rendered(renderedTree).props.store.getSnapshot().state.snapshot?.waiting.kind).toBe("none")

    session.close()
  })

  test("ink run session clears a standalone pre-run interaction when it aborts", async () => {
    const workflow: WorkflowDocument = { id: "wf", steps: [] }
    const terminal = {
      stderr: { isTTY: true } as unknown as NodeJS.WriteStream,
      stdin: { isTTY: true } as unknown as NodeJS.ReadStream,
    }
    let renderedTree: RenderedTree | null = null

    const session = createInkSession({
      barrierMode: "manual",
      interrupt: () => {},
      renderApp: stubRenderApp({
        onRender: (tree) => {
          renderedTree = tree
        },
      }),
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

    const secondSnapshot = rendered(renderedTree).props.store.getSnapshot().state.snapshot
    expect(secondSnapshot?.waiting.kind).toBe("interaction")
    if (secondSnapshot?.waiting.kind !== "interaction") {
      throw new Error("missing interaction")
    }
    expect(secondSnapshot.waiting.interaction.interaction_id).toBe("question-1")

    controller.abort(new Error("pre-run prompt aborted"))

    await expect(pending).rejects.toThrow("pre-run prompt aborted")
    expect(rendered(renderedTree).props.store.getSnapshot().state.snapshot?.waiting.kind).toBe("none")

    session.close()
  })
})
