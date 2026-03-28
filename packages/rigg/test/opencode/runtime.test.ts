import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Event, Part } from "@opencode-ai/sdk/v2"

import type { OpencodeServerLease } from "../../src/opencode/proc"
import { createOpencodeRuntimeSession } from "../../src/opencode/runtime"
import type { InteractionRequest } from "../../src/session/interaction"

function ok<T>(data: T) {
  return {
    data,
    error: undefined,
    request: new Request("http://localhost"),
    response: new Response(),
  } as const
}

function err<TError>(error: TError) {
  return {
    data: undefined,
    error,
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

function textPart(text: string, id = "part_1"): Part {
  return {
    id,
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

function createLease(options?: {
  abortDelayMs?: number | undefined
  events?: Event[] | undefined
  onPermissionReply?: ((input: { reply?: string }) => Promise<void> | void) | undefined
  onPrompt?: ((input: Record<string, unknown>) => Promise<void> | void) | undefined
  onQuestionReject?: ((input: { requestID: string }) => Promise<void> | void) | undefined
  onQuestionReply?: ((input: { answers?: string[][]; requestID: string }) => Promise<void> | void) | undefined
  promptDelayMs?: number | undefined
  promptText?: string | undefined
}): OpencodeServerLease {
  let delivered = false

  return {
    client: {
      app: {
        agents: async () => ok([{ name: "build" }]),
      },
      event: {
        subscribe: async () => {
          if (delivered) {
            return { stream: stream([]) }
          }

          delivered = true
          return { stream: stream(options?.events ?? []) }
        },
      },
      global: {
        health: async () => ok({ healthy: true, version: "1.3.3" }),
      },
      permission: {
        reply: async (input: { reply?: string }) => {
          await options?.onPermissionReply?.(input)
          return ok(true)
        },
      },
      question: {
        reject: async (input: { requestID: string }) => {
          await options?.onQuestionReject?.(input)
          return ok(true)
        },
        reply: async (input: { answers?: string[][]; requestID: string }) => {
          await options?.onQuestionReply?.(input)
          return ok(true)
        },
      },
      session: {
        abort: async () => ok(true),
        create: async () => ok({ id: "session_1" }),
        prompt: async (input: Record<string, unknown>, init?: { signal?: AbortSignal }) => {
          await options?.onPrompt?.(input)
          if (options?.abortDelayMs === undefined) {
            if (options?.promptDelayMs !== undefined) {
              await Bun.sleep(options.promptDelayMs)
            }
            return ok({
              info: assistant(options?.promptText ?? "done"),
              parts: [textPart(options?.promptText ?? "done")],
            })
          }

          await new Promise((_, reject) => {
            const fail = () => reject(init?.signal?.reason ?? new DOMException("operation aborted", "AbortError"))
            init?.signal?.addEventListener("abort", fail, { once: true })
          })
          throw new Error("unreachable")
        },
      },
    } as never,
    close: async () => {},
    markStale: () => {},
    stopNow: async () => {},
    url: "http://127.0.0.1:4096",
  }
}

describe("opencode/runtime", () => {
  test("runs successfully with the standard SDK response envelopes", async () => {
    let agentCalls = 0
    let sessionCreates = 0
    const lease = createLease()
    lease.client.app.agents = (async () => {
      agentCalls += 1
      return ok([{ name: "build" }])
    }) as never
    lease.client.session.create = (async () => {
      sessionCreates += 1
      return ok({ id: "session_1" })
    }) as never

    const run = await createOpencodeRuntimeSession({
      cwd: process.cwd(),
      env: process.env,
      internals: {
        acquireServer: async () => lease,
      },
      scopeId: process.cwd(),
    })

    const result = await run.run({
      cwd: process.cwd(),
      prompt: "Analyze the project",
    })

    expect(result.exitCode).toBe(0)
    expect(result.result).toBe("done")
    expect(agentCalls).toBe(1)
    expect(sessionCreates).toBe(1)
    await run.close()
  })

  test("rejects bare model names before calling OpenCode", async () => {
    let prompts = 0
    const lease = createLease({
      onPrompt: async () => {
        prompts += 1
      },
    })
    const run = await createOpencodeRuntimeSession({
      cwd: process.cwd(),
      env: process.env,
      internals: {
        acquireServer: async () => lease,
      },
      scopeId: process.cwd(),
    })

    const result = await run.run({
      cwd: process.cwd(),
      model: "claude-sonnet-4",
      prompt: "Analyze the project",
    })

    expect(result.exitCode).toBe(1)
    expect(result.termination).toBe("failed")
    expect(result.stderr).toContain('Invalid OpenCode model "claude-sonnet-4". Use "provider/model".')
    expect(prompts).toBe(0)
    await run.close()
  })

  test("returns a failed step when session creation returns an SDK error envelope", async () => {
    const lease = createLease()
    lease.client.session.create = (async () => err({ data: { message: "create failed" } })) as never

    const run = await createOpencodeRuntimeSession({
      cwd: process.cwd(),
      env: process.env,
      internals: {
        acquireServer: async () => lease,
      },
      scopeId: process.cwd(),
    })

    const result = await run.run({
      cwd: process.cwd(),
      prompt: "Analyze the project",
    })

    expect(result.exitCode).toBe(1)
    expect(result.termination).toBe("failed")
    expect(result.stderr).toContain("OpenCode session.create failed: create failed")
    await run.close()
  })

  test("passes the configured OpenCode binary path into server acquisition", async () => {
    const seen: { binaryPath?: string | undefined }[] = []
    const lease = createLease()
    const run = await createOpencodeRuntimeSession({
      binaryPath: "/tmp/fake-opencode",
      cwd: process.cwd(),
      env: process.env,
      internals: {
        acquireServer: async (options) => {
          seen.push({ binaryPath: options.binaryPath })
          return lease
        },
      },
      scopeId: process.cwd(),
    })

    const result = await run.run({
      cwd: process.cwd(),
      prompt: "Analyze the project",
    })

    expect(result.exitCode).toBe(0)
    expect(seen).toEqual([{ binaryPath: "/tmp/fake-opencode" }])
    await run.close()
  })

  test("aborts the in-flight prompt when the run is interrupted", async () => {
    let aborted = false
    let stopNow = 0
    let sessionAbort = 0
    const lease = createLease({ abortDelayMs: 10 })
    lease.client.session.abort = async () => {
      sessionAbort += 1
      return ok(true)
    }
    lease.stopNow = async () => {
      stopNow += 1
    }
    lease.client.session.prompt = async (_input: Record<string, unknown>, init?: { signal?: AbortSignal }) => {
      await new Promise((_, reject) => {
        const fail = () => {
          aborted = true
          reject(init?.signal?.reason ?? new DOMException("operation aborted", "AbortError"))
        }
        init?.signal?.addEventListener("abort", fail, { once: true })
      })
      throw new Error("unreachable")
    }

    const run = await createOpencodeRuntimeSession({
      cwd: process.cwd(),
      env: process.env,
      internals: {
        acquireServer: async () => lease,
      },
      scopeId: process.cwd(),
    })
    const ctrl = new AbortController()
    const pending = run.run({
      cwd: process.cwd(),
      prompt: "Stop now",
      signal: ctrl.signal,
    })

    setTimeout(() => ctrl.abort(new Error("stop")), 20)

    const result = await pending

    expect(result.exitCode).toBe(130)
    expect(result.termination).toBe("interrupted")
    expect(aborted).toBe(true)
    expect(sessionAbort).toBe(1)
    expect(stopNow).toBe(1)
    await run.close()
  })

  test("replies to OpenCode question requests through the interaction handler", async () => {
    const seen: InteractionRequest[] = []
    const replies: string[][][] = []
    const lease = createLease({
      events: [
        {
          properties: {
            id: "question_1",
            questions: [
              {
                custom: false,
                header: "Choice",
                options: [
                  { description: "", label: "A" },
                  { description: "", label: "B" },
                ],
                question: "Pick an option",
              },
              {
                custom: true,
                header: "Targets",
                multiple: true,
                options: [
                  { description: "", label: "alpha" },
                  { description: "", label: "beta" },
                ],
                question: "Pick one or more targets",
              },
            ],
            sessionID: "session_1",
          },
          type: "question.asked",
        },
      ],
      onQuestionReply: async (input) => {
        replies.push(input.answers ?? [])
      },
      promptDelayMs: 20,
      promptText: "done",
    })

    const run = await createOpencodeRuntimeSession({
      cwd: process.cwd(),
      env: process.env,
      internals: {
        acquireServer: async () => lease,
      },
      scopeId: process.cwd(),
    })

    const result = await run.run({
      cwd: process.cwd(),
      interactionHandler: async (request) => {
        seen.push(request)
        return {
          answers: {
            question_1: { answers: ["2"] },
            question_2: { answers: ["1, beta"] },
          },
          kind: "user_input",
        }
      },
      prompt: "Need clarification",
    })

    expect(result.exitCode).toBe(0)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      itemId: "question_1",
      kind: "user_input",
      requestId: "question_1",
      turnId: "session_1",
    })
    expect(replies).toEqual([[["B"], ["alpha", "beta"]]])
    await run.close()
  })

  test("keeps non-bare numeric custom answers verbatim", async () => {
    const replies: string[][][] = []
    const lease = createLease({
      events: [
        {
          properties: {
            id: "question_1",
            questions: [
              {
                custom: true,
                header: "Targets",
                options: [
                  { description: "", label: "main.ts" },
                  { description: "", label: "README.md" },
                ],
                question: "Pick a file or enter a custom answer",
              },
            ],
            sessionID: "session_1",
          },
          type: "question.asked",
        },
      ],
      onQuestionReply: async (input) => {
        replies.push(input.answers ?? [])
      },
      promptDelayMs: 20,
      promptText: "done",
    })

    const run = await createOpencodeRuntimeSession({
      cwd: process.cwd(),
      env: process.env,
      internals: {
        acquireServer: async () => lease,
      },
      scopeId: process.cwd(),
    })

    const result = await run.run({
      cwd: process.cwd(),
      interactionHandler: async () => ({
        answers: {
          question_1: { answers: ["1/main.ts"] },
        },
        kind: "user_input",
      }),
      prompt: "Need clarification",
    })

    expect(result.exitCode).toBe(0)
    expect(replies).toEqual([[["1/main.ts"]]])
    await run.close()
  })

  test("fails immediately when question handling throws", async () => {
    const lease = createLease({
      events: [
        {
          properties: {
            id: "question_1",
            questions: [
              {
                custom: false,
                header: "Choice",
                options: [{ description: "", label: "A" }],
                question: "Pick an option",
              },
            ],
            sessionID: "session_1",
          },
          type: "question.asked",
        },
      ],
      promptDelayMs: 20,
      promptText: "done",
    })

    const run = await createOpencodeRuntimeSession({
      cwd: process.cwd(),
      env: process.env,
      internals: {
        acquireServer: async () => lease,
      },
      scopeId: process.cwd(),
    })

    const result = await run.run({
      cwd: process.cwd(),
      interactionHandler: async () => {
        throw new Error("bad question handler")
      },
      prompt: "Need clarification",
    })

    expect(result.exitCode).toBe(1)
    expect(result.termination).toBe("failed")
    expect(result.stderr).toContain("bad question handler")
    await run.close()
  })

  test("fails immediately when permission handling returns the wrong resolution kind", async () => {
    const replies: string[] = []
    const lease = createLease({
      events: [
        {
          properties: {
            always: [],
            id: "perm_1",
            metadata: {},
            patterns: ["src/index.ts"],
            permission: "edit",
            sessionID: "session_1",
          },
          type: "permission.asked",
        },
      ],
      onPermissionReply: async (input) => {
        replies.push(input.reply ?? "")
      },
      promptDelayMs: 20,
      promptText: "done",
    })

    const run = await createOpencodeRuntimeSession({
      cwd: process.cwd(),
      env: process.env,
      internals: {
        acquireServer: async () => lease,
      },
      scopeId: process.cwd(),
    })

    const result = await run.run({
      cwd: process.cwd(),
      interactionHandler: async () => ({
        answers: {},
        kind: "user_input",
      }),
      prompt: "Edit the file",
    })

    expect(result.exitCode).toBe(1)
    expect(result.termination).toBe("failed")
    expect(result.stderr).toContain("expected an approval resolution")
    expect(replies).toEqual([])
    await run.close()
  })

  test("rejects default-mode permissions when no interaction handler is available", async () => {
    const replies: string[] = []
    const lease = createLease({
      events: [
        {
          properties: {
            always: [],
            id: "perm_1",
            metadata: {},
            patterns: [],
            permission: "edit",
            sessionID: "session_1",
          },
          type: "permission.asked",
        },
      ],
      onPermissionReply: async (input) => {
        replies.push(input.reply ?? "")
      },
      promptDelayMs: 20,
      promptText: "done",
    })

    const run = await createOpencodeRuntimeSession({
      cwd: process.cwd(),
      env: process.env,
      internals: {
        acquireServer: async () => lease,
      },
      scopeId: process.cwd(),
    })

    const result = await run.run({
      cwd: process.cwd(),
      permissionMode: "default",
      prompt: "Edit the file",
    })

    expect(result.exitCode).toBe(0)
    expect(replies).toEqual(["reject"])
    await run.close()
  })

  test("keeps multiple text parts from the same message distinct while streaming", async () => {
    const seen: Array<Record<string, unknown>> = []
    const lease = createLease({
      events: [
        {
          properties: {
            delta: "Hello",
            field: "text",
            messageID: "msg_1",
            partID: "part_1",
            sessionID: "session_1",
          },
          type: "message.part.delta",
        },
        {
          properties: {
            delta: "After tool",
            field: "text",
            messageID: "msg_1",
            partID: "part_2",
            sessionID: "session_1",
          },
          type: "message.part.delta",
        },
      ],
    })
    lease.client.session.prompt = async () => {
      await Bun.sleep(20)
      return ok({
        info: assistant("done"),
        parts: [textPart("Hello", "part_1"), textPart("After tool", "part_2")],
      })
    }

    const run = await createOpencodeRuntimeSession({
      cwd: process.cwd(),
      env: process.env,
      internals: {
        acquireServer: async () => lease,
      },
      scopeId: process.cwd(),
    })

    const result = await run.run({
      cwd: process.cwd(),
      onEvent: (event) => {
        seen.push(event as Record<string, unknown>)
      },
      prompt: "Say two things",
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("Hello\nAfter tool")
    expect(seen.filter((event) => event["kind"] === "message_delta")).toEqual([
      {
        kind: "message_delta",
        messageId: "msg_1",
        partId: "part_1",
        provider: "opencode",
        sessionId: "session_1",
        text: "Hello",
      },
      {
        kind: "message_delta",
        messageId: "msg_1",
        partId: "part_2",
        provider: "opencode",
        sessionId: "session_1",
        text: "After tool",
      },
    ])
    expect(seen.filter((event) => event["kind"] === "message_completed")).toEqual([
      {
        kind: "message_completed",
        messageId: "msg_1",
        partId: "part_1",
        provider: "opencode",
        sessionId: "session_1",
        text: "Hello",
      },
      {
        kind: "message_completed",
        messageId: "msg_1",
        partId: "part_2",
        provider: "opencode",
        sessionId: "session_1",
        text: "After tool",
      },
    ])
    await run.close()
  })
})
