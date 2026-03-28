import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Event, Part } from "@opencode-ai/sdk/v2"

import type { OpencodeServerLease } from "../../../src/opencode/proc"
import { runOpenCodeStep } from "../../../src/session/step/opencode"
import { renderContext } from "../../fixture/builders"

function ok<T>(data: T) {
  return {
    data,
    error: undefined,
    request: new Request("http://localhost"),
    response: new Response(),
  } as const
}

function assistant(text: string): AssistantMessage {
  return {
    agent: "build",
    cost: 0,
    id: "msg_1",
    mode: "chat",
    modelID: "claude-sonnet",
    parentID: "user_1",
    path: {
      cwd: process.cwd(),
      root: process.cwd(),
    },
    providerID: "anthropic",
    role: "assistant",
    sessionID: "session_1",
    summary: false,
    time: {
      completed: Date.now(),
      created: Date.now(),
    },
    tokens: {
      cache: {
        read: 0,
        write: 0,
      },
      input: 0,
      output: 0,
      reasoning: 0,
      total: 0,
    },
  }
}

function textPart(text: string): Part {
  return {
    id: "part_1",
    messageID: "msg_1",
    sessionID: "session_1",
    text,
    time: {
      end: Date.now(),
      start: Date.now(),
    },
    type: "text",
  }
}

function stream(events: Event[]): AsyncGenerator<Event, void, unknown> {
  return (async function* () {
    for (const event of events) {
      yield event
    }
  })()
}

function createLease(options: {
  events?: Event[] | undefined
  onPrompt?: ((input: Record<string, unknown>) => Promise<void> | void) | undefined
  promptText?: string | undefined
}): {
  lease: OpencodeServerLease
  replies: string[]
} {
  const replies: string[] = []
  const lease = {
    client: {
      app: {
        agents: async () => ok([{ name: "build" }]),
      },
      event: {
        subscribe: async () => ({
          stream: stream(options.events ?? []),
        }),
      },
      global: {
        health: async () => ok({ healthy: true, version: "1.3.3" }),
      },
      permission: {
        reply: async (input: { reply?: string }) => {
          replies.push(input.reply ?? "")
          return ok(true)
        },
      },
      session: {
        abort: async () => ok(true),
        create: async () =>
          ok({
            id: "session_1",
          }),
        prompt: async (input: Record<string, unknown>) => {
          await options.onPrompt?.(input)
          await Bun.sleep(5)
          return ok({
            info: assistant(options.promptText ?? "done"),
            parts: [textPart(options.promptText ?? "done")],
          })
        },
      },
    } as never,
    close: async () => {},
    markStale: () => {},
    stopNow: async () => {},
    url: "http://127.0.0.1:4096",
  } satisfies OpencodeServerLease

  return { lease, replies }
}

describe("session/step/opencode", () => {
  test("renders the prompt and maps provider/model strings", async () => {
    const seen: Record<string, unknown>[] = []
    const { lease } = createLease({
      onPrompt: async (input) => {
        seen.push(input)
      },
      promptText: "done",
    })

    const result = await runOpenCodeStep(
      {
        type: "opencode",
        with: {
          agent: "build",
          model: "anthropic/claude-sonnet-4",
          permission_mode: "default",
          prompt: "Implement ${{ inputs.name }}",
          variant: "high",
        },
      },
      renderContext({ inputs: { name: "feature" } }),
      {
        cwd: process.cwd(),
        env: process.env,
        opencodeInternals: {
          acquireServer: async () => lease,
        },
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("done")
    expect(seen[0]?.["parts"]).toEqual([{ text: "Implement feature", type: "text" }])
    expect(seen[0]?.["model"]).toEqual({
      modelID: "claude-sonnet-4",
      providerID: "anthropic",
    })
    expect(seen[0]?.["variant"]).toBe("high")
  })

  test("passes custom OpenCode variants through to the runtime", async () => {
    const seen: Record<string, unknown>[] = []
    const { lease } = createLease({
      onPrompt: async (input) => {
        seen.push(input)
      },
      promptText: "done",
    })

    const result = await runOpenCodeStep(
      {
        type: "opencode",
        with: {
          prompt: "Implement the feature",
          variant: "quality",
        },
      },
      renderContext(),
      {
        cwd: process.cwd(),
        env: process.env,
        opencodeInternals: {
          acquireServer: async () => lease,
        },
      },
    )

    expect(result.exitCode).toBe(0)
    expect(seen[0]?.["variant"]).toBe("quality")
  })

  test("fails before calling the runtime when the rendered prompt is empty", async () => {
    const result = await runOpenCodeStep(
      {
        type: "opencode",
        with: {
          prompt: "${{ inputs.empty }}",
        },
      },
      renderContext({ inputs: { empty: "" } }),
      {
        cwd: process.cwd(),
        env: process.env,
      },
    )

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("rendered to an empty string")
  })

  test("resolves permission requests through the shared interaction plumbing", async () => {
    const { lease, replies } = createLease({
      events: [
        {
          properties: {
            always: [],
            id: "perm_1",
            metadata: {},
            patterns: ["src/index.ts"],
            permission: "edit",
            sessionID: "session_1",
            tool: {
              callID: "call_1",
              messageID: "msg_1",
            },
          },
          type: "permission.asked",
        },
        {
          properties: {
            part: {
              callID: "call_1",
              id: "tool_1",
              messageID: "msg_1",
              metadata: {},
              sessionID: "session_1",
              state: {
                input: {},
                status: "running",
                time: {
                  start: Date.now(),
                },
                title: "Edit file",
              },
              tool: "edit",
              type: "tool",
            },
            sessionID: "session_1",
            time: Date.now(),
          },
          type: "message.part.updated",
        },
      ],
      promptText: "permission handled",
    })
    const events: string[] = []

    const result = await runOpenCodeStep(
      {
        type: "opencode",
        with: {
          prompt: "Edit the file",
        },
      },
      renderContext(),
      {
        cwd: process.cwd(),
        env: process.env,
        interactionHandler: async () => ({ decision: "reject", kind: "approval" }),
        onProviderEvent: (event) => {
          events.push(event.kind)
        },
        opencodeInternals: {
          acquireServer: async () => lease,
        },
      },
    )

    expect(result.exitCode).toBe(0)
    expect(replies).toEqual(["reject"])
    expect(events).toContain("permission_requested")
    expect(events).toContain("permission_resolved")
  })
})
