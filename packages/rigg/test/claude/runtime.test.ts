import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk"

import { createClaudeRuntimeSession } from "../../src/claude/runtime"
import type { ClaudeProviderEvent } from "../../src/claude/event"
import type { InteractionRequest } from "../../src/session/interaction"
import { createFakeClaudeSdk, installFakeClaude } from "../fixture/fake-claude"

function systemInit(sessionId = "session_1"): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    uuid: "sys_1",
    session_id: sessionId,
    agents: [],
    apiKeySource: "oauth",
    claude_code_version: "2.1.81",
    cwd: "/workspace",
    mcp_servers: [],
    model: "claude-opus-4-6",
    output_style: "default",
    permissionMode: "default",
    plugins: [],
    skills: [],
    slash_commands: [],
    tools: [],
  } as unknown as SDKMessage
}

function textDelta(
  text: string,
  sessionId = "session_1",
  uuid = `delta_${text}`,
  messageId?: string | undefined,
): SDKMessage {
  const message = {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: {
        type: "text_delta",
        text,
      },
    },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid,
  } as Record<string, unknown>
  if (messageId !== undefined) {
    message["message_id"] = messageId
  }
  return message as unknown as SDKMessage
}

function assistantText(text: string, sessionId = "session_1", uuid = "msg_1"): SDKMessage {
  const message = {
    type: "assistant",
    message: {
      content: text.length === 0 ? [] : [{ type: "text", text }],
    },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid,
  }
  return message as unknown as SDKMessage
}

function assistantTool(sessionId = "session_1", uuid = "msg_tool"): SDKMessage {
  return {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "tool_1",
          name: "Bash",
          input: { command: "npm test" },
        },
      ],
    },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid,
  } as unknown as SDKMessage
}

function assistantTextAndTool(sessionId = "session_1", uuid = "msg_1"): SDKMessage {
  return {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Running tests." },
        {
          type: "tool_use",
          id: "tool_1",
          name: "Bash",
          input: { command: "npm test" },
        },
      ],
    },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid,
  } as unknown as SDKMessage
}

function assistantMixedContent(sessionId = "session_1", uuid = "msg_mixed"): SDKMessage {
  return {
    type: "assistant",
    message: {
      content: [
        "skip-me",
        { type: "text", text: "Plan:" },
        { type: "text" },
        null,
        {
          type: "tool_use",
          id: "tool_1",
          name: "Bash",
          input: { command: "npm test" },
        },
        {
          type: "tool_use",
          id: 7,
          name: "BrokenTool",
        },
      ],
    },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid,
  } as unknown as SDKMessage
}

function toolSummary(sessionId = "session_1"): SDKMessage {
  return {
    type: "tool_use_summary",
    preceding_tool_use_ids: ["tool_1"],
    session_id: sessionId,
    summary: "npm test",
    uuid: "tool_summary_1",
  } as unknown as SDKMessage
}

function authStatus(message: string, sessionId = "session_1"): SDKMessage {
  return {
    type: "auth_status",
    error: message,
    isAuthenticating: false,
    output: [],
    session_id: sessionId,
    uuid: "auth_1",
  } as unknown as SDKMessage
}

function resultSuccess(text: string, sessionId = "session_1"): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    duration_api_ms: 1,
    duration_ms: 1,
    is_error: false,
    modelUsage: {},
    num_turns: 1,
    permission_denials: [],
    result: text,
    session_id: sessionId,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      server_tool_use: null,
      service_tier: null,
      cache_creation: null,
    },
    uuid: "result_1",
  } as unknown as SDKMessage
}

function resultError(message: string, sessionId = "session_1"): SDKMessage {
  return {
    type: "result",
    subtype: "error_during_execution",
    duration_api_ms: 1,
    duration_ms: 1,
    errors: [message],
    is_error: true,
    modelUsage: {},
    num_turns: 1,
    permission_denials: [],
    session_id: sessionId,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      server_tool_use: null,
      service_tier: null,
      cache_creation: null,
    },
    uuid: "result_err_1",
  } as unknown as SDKMessage
}

function deferred<T>() {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined
  let reject: ((reason?: unknown) => void) | undefined
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  if (resolve === undefined || reject === undefined) {
    throw new Error("failed to create deferred promise")
  }
  return { promise, reject, resolve }
}

async function withSession<T>(
  fn: (input: {
    events: ClaudeProviderEvent[]
    root: string
    run: Parameters<Awaited<ReturnType<typeof createClaudeRuntimeSession>>["run"]>[0]
    runtime: Awaited<ReturnType<typeof createClaudeRuntimeSession>>
  }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "rigg-claude-runtime-"))
  const events: ClaudeProviderEvent[] = []
  const binDir = await installFakeClaude(root)
  const runtime = await createClaudeRuntimeSession({
    cwd: root,
    env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
  })

  try {
    return await fn({
      events,
      root,
      run: {
        cwd: root,
        onEvent: (event) => {
          events.push(event)
        },
        prompt: "Implement the change.",
      },
      runtime,
    })
  } finally {
    await runtime.close()
    await rm(root, { force: true, recursive: true })
  }
}

describe("claude/runtime", () => {
  test("streams assistant text and returns the final result", async () => {
    await withSession(async ({ root, events, run }) => {
      const { sdk } = createFakeClaudeSdk({
        messages: [systemInit(), textDelta("hel"), textDelta("lo"), assistantText("hello"), resultSuccess("hello")],
      })
      const runtime = await createClaudeRuntimeSession({
        cwd: root,
        env: process.env,
        sdk,
      })

      try {
        const result = await runtime.run(run)
        expect(result.result).toBe("hello")
        expect(events).toContainEqual({
          kind: "message_delta",
          messageId: "delta_hel",
          provider: "claude",
          sessionId: "session_1",
          text: "hel",
        })
        expect(events).toContainEqual({
          kind: "message_completed",
          messageId: "delta_hel",
          provider: "claude",
          sessionId: "session_1",
          text: "hello",
        })
      } finally {
        await runtime.close()
      }
    })
  })

  test("skips claude cli checks when using an injected sdk", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-claude-sdk-"))
    const { sdk } = createFakeClaudeSdk({
      messages: [systemInit(), resultSuccess("done")],
    })
    const runtime = await createClaudeRuntimeSession({
      binaryPath: "/missing/claude",
      cwd: root,
      env: process.env,
      sdk,
    })

    try {
      const result = await runtime.run({
        cwd: root,
        prompt: "Implement the change.",
      })
      expect(result.result).toBe("done")
      expect(result.termination).toBe("completed")
    } finally {
      await runtime.close()
      await rm(root, { force: true, recursive: true })
    }
  })

  test("reuses the streamed message id for the completed assistant reply", async () => {
    await withSession(async ({ root, events, run }) => {
      const { sdk } = createFakeClaudeSdk({
        messages: [
          systemInit(),
          textDelta("hel", "session_1", "delta_1", "msg_1"),
          textDelta("lo", "session_1", "delta_2", "msg_1"),
          assistantText("hello"),
          resultSuccess("hello"),
        ],
      })
      const runtime = await createClaudeRuntimeSession({
        cwd: root,
        env: process.env,
        sdk,
      })

      try {
        await runtime.run(run)
        expect(events).toContainEqual({
          kind: "message_delta",
          messageId: "msg_1",
          provider: "claude",
          sessionId: "session_1",
          text: "hel",
        })
        expect(events).toContainEqual({
          kind: "message_delta",
          messageId: "msg_1",
          provider: "claude",
          sessionId: "session_1",
          text: "lo",
        })
        expect(events).toContainEqual({
          kind: "message_completed",
          messageId: "msg_1",
          provider: "claude",
          sessionId: "session_1",
          text: "hello",
        })
      } finally {
        await runtime.close()
      }
    })
  })

  test("preserves streamed text when the terminal result is empty", async () => {
    await withSession(async ({ root, run }) => {
      const { sdk } = createFakeClaudeSdk({
        messages: [systemInit(), textDelta("he"), textDelta("llo"), assistantText(""), resultSuccess("")],
      })
      const runtime = await createClaudeRuntimeSession({
        cwd: root,
        env: process.env,
        sdk,
      })

      try {
        const result = await runtime.run(run)
        expect(result.result).toBe("hello")
        expect(result.stdout).toBe("hello")
      } finally {
        await runtime.close()
      }
    })
  })

  test("merges streamed text when claude reveals message_id mid-stream", async () => {
    await withSession(async ({ root, run }) => {
      const { sdk } = createFakeClaudeSdk({
        messages: [
          systemInit(),
          textDelta("hel", "session_1", "delta_1"),
          textDelta("lo", "session_1", "delta_2", "msg_1"),
          assistantText(""),
          resultSuccess(""),
        ],
      })
      const runtime = await createClaudeRuntimeSession({
        cwd: root,
        env: process.env,
        sdk,
      })

      try {
        const result = await runtime.run(run)
        expect(result.result).toBe("hello")
        expect(result.stdout).toBe("hello")
      } finally {
        await runtime.close()
      }
    })
  })

  test("preserves later assistant text after a streamed preamble when the terminal result is empty", async () => {
    await withSession(async ({ root, run }) => {
      const { sdk } = createFakeClaudeSdk({
        messages: [
          systemInit(),
          textDelta("Running "),
          textDelta("tests..."),
          assistantTool(),
          toolSummary(),
          assistantText("All tests passed."),
          resultSuccess(""),
        ],
      })
      const runtime = await createClaudeRuntimeSession({
        cwd: root,
        env: process.env,
        sdk,
      })

      try {
        const result = await runtime.run(run)
        expect(result.result).toBe("All tests passed.")
        expect(result.stdout).toBe("All tests passed.")
      } finally {
        await runtime.close()
      }
    })
  })

  test("fails when the query ends before emitting a result", async () => {
    await withSession(async ({ root, run }) => {
      const { sdk } = createFakeClaudeSdk({
        messages: [systemInit(), textDelta("partial"), assistantText("partial")],
      })
      const runtime = await createClaudeRuntimeSession({
        cwd: root,
        env: process.env,
        sdk,
      })

      try {
        const result = await runtime.run(run)
        expect(result.exitCode).toBe(1)
        expect(result.result).toBeNull()
        expect(result.stdout).toBe("partial")
        expect(result.stderr).toContain("ended before emitting a result")
        expect(result.termination).toBe("failed")
      } finally {
        await runtime.close()
      }
    })
  })

  test("emits tool lifecycle after message_completed when assistant text precedes tools", async () => {
    await withSession(async ({ root, events, run }) => {
      const { sdk } = createFakeClaudeSdk({
        messages: [systemInit(), assistantTextAndTool(), toolSummary(), resultSuccess("done")],
      })
      const runtime = await createClaudeRuntimeSession({
        cwd: root,
        env: process.env,
        sdk,
      })

      try {
        await runtime.run(run)
        expect(events.some((event) => event.kind === "message_completed")).toBe(true)
        expect(events).toContainEqual({
          detail: "npm test",
          kind: "tool_started",
          provider: "claude",
          sessionId: "session_1",
          tool: "Bash",
        })
        expect(events).toContainEqual({
          detail: "npm test",
          kind: "tool_completed",
          provider: "claude",
          sessionId: "session_1",
          tool: "Bash",
        })
      } finally {
        await runtime.close()
      }
    })
  })

  test("ignores malformed assistant content entries while preserving valid text and tools", async () => {
    await withSession(async ({ root, events, run }) => {
      const { sdk } = createFakeClaudeSdk({
        messages: [systemInit(), assistantMixedContent(), toolSummary(), resultSuccess("done")],
      })
      const runtime = await createClaudeRuntimeSession({
        cwd: root,
        env: process.env,
        sdk,
      })

      try {
        await runtime.run(run)
        expect(events).toContainEqual({
          kind: "message_completed",
          messageId: "msg_mixed",
          provider: "claude",
          sessionId: "session_1",
          text: "Plan:",
        })
        expect(events).toContainEqual({
          detail: "npm test",
          kind: "tool_started",
          provider: "claude",
          sessionId: "session_1",
          tool: "Bash",
        })
        expect(events.filter((event) => event.kind === "tool_started")).toHaveLength(1)
      } finally {
        await runtime.close()
      }
    })
  })

  test("translates tool lifecycle events", async () => {
    await withSession(async ({ root, events, run }) => {
      const { sdk } = createFakeClaudeSdk({
        messages: [systemInit(), assistantTool(), toolSummary(), resultSuccess("done")],
      })
      const runtime = await createClaudeRuntimeSession({
        cwd: root,
        env: process.env,
        sdk,
      })

      try {
        await runtime.run(run)
        expect(events).toContainEqual({
          detail: "npm test",
          kind: "tool_started",
          provider: "claude",
          sessionId: "session_1",
          tool: "Bash",
        })
        expect(events).toContainEqual({
          detail: "npm test",
          kind: "tool_completed",
          provider: "claude",
          sessionId: "session_1",
          tool: "Bash",
        })
      } finally {
        await runtime.close()
      }
    })
  })

  test("routes approval requests through the interaction handler", async () => {
    await withSession(async ({ root, run }) => {
      const requests: InteractionRequest[] = []
      const { sdk } = createFakeClaudeSdk({
        onQuery: async (options) => {
          await options?.canUseTool?.(
            "Bash",
            { command: "npm test" },
            {
              signal: new AbortController().signal,
              toolUseID: "tool_1",
            },
          )
          return [systemInit(), resultSuccess("done")]
        },
      })
      const runtime = await createClaudeRuntimeSession({
        cwd: root,
        env: process.env,
        sdk,
      })

      try {
        await runtime.run({
          ...run,
          interactionHandler: (request) => {
            requests.push(request)
            if (request.kind === "approval") {
              return { decision: "allow", kind: "approval" }
            }
            throw new Error("unexpected request")
          },
        })
        expect(requests[0]).toMatchObject({
          command: "npm test",
          kind: "approval",
          requestKind: "command_execution",
        })
      } finally {
        await runtime.close()
      }
    })
  })

  test("uses distinct fallback interaction ids before session init", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "rigg-claude-approval-a-"))
    const rootB = await mkdtemp(join(tmpdir(), "rigg-claude-approval-b-"))
    const [binDirA, binDirB] = await Promise.all([installFakeClaude(rootA), installFakeClaude(rootB)])
    const requests: InteractionRequest[] = []
    const createSdk = () =>
      createFakeClaudeSdk({
        onQuery: async (options) => {
          await options?.canUseTool?.(
            "Bash",
            { command: "npm test" },
            {
              signal: new AbortController().signal,
              toolUseID: "tool_1",
            },
          )
          return [systemInit(), resultSuccess("done")]
        },
      }).sdk
    const runtimeA = await createClaudeRuntimeSession({
      cwd: rootA,
      env: { ...process.env, PATH: `${binDirA}:${process.env["PATH"] ?? ""}` },
      sdk: createSdk(),
    })
    const runtimeB = await createClaudeRuntimeSession({
      cwd: rootB,
      env: { ...process.env, PATH: `${binDirB}:${process.env["PATH"] ?? ""}` },
      sdk: createSdk(),
    })

    try {
      await Promise.all([
        runtimeA.run({
          cwd: rootA,
          interactionHandler: (request) => {
            requests.push(request)
            if (request.kind !== "approval") {
              throw new Error("unexpected request")
            }
            return { decision: "allow", kind: "approval" }
          },
          prompt: "Implement the change.",
        }),
        runtimeB.run({
          cwd: rootB,
          interactionHandler: (request) => {
            requests.push(request)
            if (request.kind !== "approval") {
              throw new Error("unexpected request")
            }
            return { decision: "allow", kind: "approval" }
          },
          prompt: "Implement the change.",
        }),
      ])

      expect(requests).toHaveLength(2)
      const first = requests[0]
      const second = requests[1]
      if (first === undefined || second === undefined) {
        throw new Error("expected approval requests")
      }
      expect(first).toMatchObject({
        kind: "approval",
        requestId: expect.stringMatching(/^claude:claude-[^:]+:tool_1$/),
        turnId: expect.stringMatching(/^claude-[^:]+$/),
      })
      expect(second).toMatchObject({
        kind: "approval",
        requestId: expect.stringMatching(/^claude:claude-[^:]+:tool_1$/),
        turnId: expect.stringMatching(/^claude-[^:]+$/),
      })
      if (first.kind !== "approval" || second.kind !== "approval") {
        throw new Error("expected approval requests")
      }
      expect(first.requestId).not.toBe(second.requestId)
      expect(first.turnId).not.toBe(second.turnId)
    } finally {
      await runtimeA.close()
      await runtimeB.close()
      await Promise.all([rm(rootA, { force: true, recursive: true }), rm(rootB, { force: true, recursive: true })])
    }
  })

  test("aborts approval requests when Claude withdraws the prompt", async () => {
    await withSession(async ({ root, run }) => {
      const requests: InteractionRequest[] = []
      const gate = deferred<void>()
      const { sdk } = createFakeClaudeSdk({
        onQuery: async (options) => {
          const controller = new AbortController()
          const pending = options?.canUseTool?.(
            "Bash",
            { command: "npm test" },
            {
              signal: controller.signal,
              toolUseID: "tool_1",
            },
          )
          if (pending === undefined) {
            throw new Error("missing canUseTool")
          }
          queueMicrotask(() => controller.abort("superseded"))
          await expect(pending).rejects.toThrow("superseded")
          return [systemInit(), resultSuccess("done")]
        },
      })
      const runtime = await createClaudeRuntimeSession({
        cwd: root,
        env: process.env,
        sdk,
      })

      try {
        await runtime.run({
          ...run,
          interactionHandler: async (request) => {
            requests.push(request)
            if (request.kind !== "approval") {
              throw new Error("unexpected request")
            }
            await gate.promise
            return { decision: "allow", kind: "approval" }
          },
        })
        expect(requests).toHaveLength(1)
      } finally {
        gate.resolve()
        await runtime.close()
      }
    })
  })

  test("routes form input requests through the interaction handler", async () => {
    await withSession(async ({ root, run }) => {
      const requests: InteractionRequest[] = []
      const { sdk } = createFakeClaudeSdk({
        onQuery: async (options) => {
          await options?.onElicitation?.(
            {
              message: "Which branch should we target?",
              mode: "form",
              requestedSchema: {
                properties: {
                  branch: {
                    description: "Which branch should we target?",
                    enum: ["main", "develop"],
                    title: "Branch",
                    type: "string",
                  },
                },
                required: ["branch"],
              },
              serverName: "test-server",
            },
            { signal: new AbortController().signal },
          )
          return [systemInit(), resultSuccess("done")]
        },
      })
      const runtime = await createClaudeRuntimeSession({
        cwd: root,
        env: process.env,
        sdk,
      })

      try {
        await runtime.run({
          ...run,
          interactionHandler: (request) => {
            requests.push(request)
            if (request.kind === "user_input") {
              return {
                answers: {
                  branch: {
                    answers: ["main"],
                  },
                },
                kind: "user_input",
              }
            }
            throw new Error("unexpected request")
          },
        })
        expect(requests[0]).toMatchObject({
          kind: "user_input",
          questions: [
            {
              header: "Branch",
              id: "branch",
            },
          ],
        })
      } finally {
        await runtime.close()
      }
    })
  })

  test("ignores malformed schema properties and preserves labeled option values", async () => {
    await withSession(async ({ root, run }) => {
      const requests: InteractionRequest[] = []
      let content: unknown = null
      const { sdk } = createFakeClaudeSdk({
        onQuery: async (options) => {
          const result = await options?.onElicitation?.(
            {
              message: "Choose values",
              mode: "form",
              requestedSchema: {
                properties: {
                  branch: {
                    description: "Which branch should we target?",
                    oneOf: [
                      { const: "main", title: "Main branch" },
                      { const: "develop", title: "Develop branch" },
                    ],
                    title: "Branch",
                    type: "string",
                  },
                  retries: {
                    enum: [1, 3],
                    title: "Retries",
                    type: "integer",
                  },
                  invalid: "skip-me",
                },
                required: ["branch"],
              },
              serverName: "test-server",
            },
            { signal: new AbortController().signal },
          )
          content = result?.content ?? null
          return [systemInit(), resultSuccess("done")]
        },
      })
      const runtime = await createClaudeRuntimeSession({
        cwd: root,
        env: process.env,
        sdk,
      })

      try {
        await runtime.run({
          ...run,
          interactionHandler: (request) => {
            requests.push(request)
            if (request.kind !== "user_input") {
              throw new Error("unexpected request")
            }
            return {
              answers: {
                branch: {
                  answers: ["Main branch"],
                },
                retries: {
                  answers: ["3"],
                },
              },
              kind: "user_input",
            }
          },
        })

        expect(requests[0]).toMatchObject({
          kind: "user_input",
          questions: [
            {
              allowEmpty: false,
              header: "Branch",
              id: "branch",
              options: [
                { description: "", label: "Main branch" },
                { description: "", label: "Develop branch" },
              ],
            },
            {
              allowEmpty: true,
              header: "Retries",
              id: "retries",
              options: [
                { description: "", label: "1" },
                { description: "", label: "3" },
              ],
            },
          ],
        })
        if (content === null) {
          throw new Error("expected elicitation content")
        }
        expect(content).toEqual({
          branch: "main",
          retries: 3,
        })
      } finally {
        await runtime.close()
      }
    })
  })

  test("aborts form input requests when Claude cancels the elicitation", async () => {
    await withSession(async ({ root, run }) => {
      const requests: InteractionRequest[] = []
      const gate = deferred<void>()
      const { sdk } = createFakeClaudeSdk({
        onQuery: async (options) => {
          const controller = new AbortController()
          const pending = options?.onElicitation?.(
            {
              message: "Which branch should we target?",
              mode: "form",
              requestedSchema: {
                properties: {
                  branch: {
                    description: "Which branch should we target?",
                    enum: ["main", "develop"],
                    title: "Branch",
                    type: "string",
                  },
                },
                required: ["branch"],
              },
              serverName: "test-server",
            },
            { signal: controller.signal },
          )
          if (pending === undefined) {
            throw new Error("missing onElicitation")
          }
          queueMicrotask(() => controller.abort("form cancelled"))
          await expect(pending).rejects.toThrow("form cancelled")
          return [systemInit(), resultSuccess("done")]
        },
      })
      const runtime = await createClaudeRuntimeSession({
        cwd: root,
        env: process.env,
        sdk,
      })

      try {
        await runtime.run({
          ...run,
          interactionHandler: async (request) => {
            requests.push(request)
            if (request.kind !== "user_input") {
              throw new Error("unexpected request")
            }
            await gate.promise
            return {
              answers: {
                branch: {
                  answers: ["main"],
                },
              },
              kind: "user_input",
            }
          },
        })
        expect(requests).toHaveLength(1)
      } finally {
        gate.resolve()
        await runtime.close()
      }
    })
  })

  test("aborts url elicitations when Claude cancels the prompt", async () => {
    await withSession(async ({ root, run }) => {
      const requests: InteractionRequest[] = []
      const gate = deferred<void>()
      const { sdk } = createFakeClaudeSdk({
        onQuery: async (options) => {
          const controller = new AbortController()
          const pending = options?.onElicitation?.(
            {
              elicitationId: "elicitation_1",
              message: "Open the review URL",
              mode: "url",
              serverName: "test-server",
              url: "https://example.com/review",
            },
            { signal: controller.signal },
          )
          if (pending === undefined) {
            throw new Error("missing onElicitation")
          }
          queueMicrotask(() => controller.abort("url cancelled"))
          await expect(pending).rejects.toThrow("url cancelled")
          return [systemInit(), resultSuccess("done")]
        },
      })
      const runtime = await createClaudeRuntimeSession({
        cwd: root,
        env: process.env,
        sdk,
      })

      try {
        await runtime.run({
          ...run,
          interactionHandler: async (request) => {
            requests.push(request)
            if (request.kind !== "elicitation") {
              throw new Error("unexpected request")
            }
            await gate.promise
            return { action: "accept", kind: "elicitation" }
          },
        })
        expect(requests).toHaveLength(1)
      } finally {
        gate.resolve()
        await runtime.close()
      }
    })
  })

  test("preserves scalar enum values in elicitation responses", async () => {
    await withSession(async ({ root, run }) => {
      let content: Record<string, unknown> | null = null
      const { sdk } = createFakeClaudeSdk({
        onQuery: async (options) => {
          const result = await options?.onElicitation?.(
            {
              message: "Choose values",
              mode: "form",
              requestedSchema: {
                properties: {
                  branch: {
                    enum: ["main", "develop"],
                    title: "Branch",
                    type: "string",
                  },
                  retries: {
                    enum: [1, 3, 5],
                    title: "Retries",
                    type: "integer",
                  },
                  confirm: {
                    oneOf: [
                      { const: true, title: "Yes" },
                      { const: false, title: "No" },
                    ],
                    title: "Confirm",
                    type: "boolean",
                  },
                },
                required: ["branch", "retries", "confirm"],
              },
              serverName: "test-server",
            },
            { signal: new AbortController().signal },
          )
          content = result?.content as Record<string, unknown>
          return [systemInit(), resultSuccess("done")]
        },
      })
      const runtime = await createClaudeRuntimeSession({
        cwd: root,
        env: process.env,
        sdk,
      })

      try {
        await runtime.run({
          ...run,
          interactionHandler: (request) => {
            if (request.kind !== "user_input") {
              throw new Error("unexpected request")
            }
            return {
              answers: {
                branch: { answers: ["main"] },
                confirm: { answers: ["Yes"] },
                retries: { answers: ["3"] },
              },
              kind: "user_input",
            }
          },
        })
        expect(content).not.toBeNull()
        expect(content!).toEqual({
          branch: "main",
          confirm: true,
          retries: 3,
        })
      } finally {
        await runtime.close()
      }
    })
  })

  test("normalizes auth failures to a claude login instruction", async () => {
    await withSession(async ({ root, run }) => {
      const { sdk } = createFakeClaudeSdk({
        messages: [systemInit(), authStatus("authentication_failed"), resultError("authentication_failed")],
      })
      const runtime = await createClaudeRuntimeSession({
        cwd: root,
        env: process.env,
        sdk,
      })

      try {
        const result = await runtime.run(run)
        expect(result.stderr).toContain("claude login")
        expect(result.termination).toBe("failed")
      } finally {
        await runtime.close()
      }
    })
  })

  test("interrupts the active query and reports an interrupted termination", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-claude-interrupt-"))
    const binDir = await installFakeClaude(root)
    const state = { interrupted: false }
    const sdk = {
      query() {
        let done = false
        const query = {
          async next() {
            if (state.interrupted || done) {
              done = true
              return { done: true, value: undefined }
            }
            await new Promise((resolve) => setTimeout(resolve, 100))
            if (state.interrupted) {
              done = true
              return { done: true, value: undefined }
            }
            return { done: false, value: systemInit() as never }
          },
          async return() {
            done = true
            return { done: true, value: undefined }
          },
          async throw(error: unknown) {
            done = true
            throw error
          },
          [Symbol.asyncIterator]() {
            return this
          },
          async [Symbol.asyncDispose]() {
            done = true
          },
          async interrupt() {
            state.interrupted = true
          },
          async rewindFiles() {
            return { canRewind: false }
          },
          async setPermissionMode() {},
          async setModel() {},
          async setMaxThinkingTokens() {},
          async applyFlagSettings() {},
          async initializationResult() {
            return {
              account: {},
              agents: [],
              available_output_styles: [],
              commands: [],
              models: [],
              output_style: "default",
            }
          },
          async supportedCommands() {
            return []
          },
          async supportedModels() {
            return []
          },
          async supportedAgents() {
            return []
          },
          async mcpServerStatus() {
            return []
          },
          async accountInfo() {
            return {}
          },
          async reconnectMcpServer() {},
          async toggleMcpServer() {},
          async setMcpServers() {
            return { added: [], errors: {}, removed: [] }
          },
          async streamInput() {},
          async stopTask() {},
          close() {
            done = true
          },
        }
        return query as Query
      },
    }
    const runtime = await createClaudeRuntimeSession({
      cwd: root,
      env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
      sdk,
    })

    try {
      const runPromise = runtime.run({
        cwd: root,
        prompt: "Implement",
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      await runtime.interrupt()
      const result = await runPromise
      expect(state.interrupted).toBe(true)
      expect(result.termination).toBe("interrupted")
    } finally {
      await runtime.close()
      await rm(root, { force: true, recursive: true })
    }
  })
})
