import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { describe, expect, test } from "bun:test"

import { createCursorRuntimeSession } from "../../src/cursor/runtime"
import { installFakeCursor } from "../fixture/fake-cursor"

describe("cursor/runtime", () => {
  test("sends agent mode for run sessions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "rigg-cursor-runtime-agent-mode-"))

    try {
      const binDir = await installFakeCursor(cwd, {
        sessionNew: {
          expectParams: {
            cwd,
            mcpServers: [],
            mode: "agent",
          },
        },
        sessionPrompt: {
          dispatch: "immediate",
          steps: [
            {
              kind: "notification",
              method: "session/update",
              params: {
                sessionId: "__SESSION_ID__",
                update: {
                  content: { text: "agent mode", type: "text" },
                  messageId: "msg_1",
                  sessionUpdate: "agent_message_chunk",
                },
              },
            },
          ],
        },
      })

      const runtime = await createCursorRuntimeSession({
        binaryPath: join(binDir, "cursor"),
        cwd,
        env: process.env,
      })

      try {
        await expect(
          runtime.run({
            action: "run",
            cwd,
            prompt: "Use agent mode",
          }),
        ).resolves.toMatchObject({
          exitCode: 0,
          stdout: "agent mode",
          termination: "completed",
        })
      } finally {
        await runtime.close()
      }
    } finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })

  test("handles cursor extension interaction requests", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "rigg-cursor-runtime-extension-request-"))

    try {
      const binDir = await installFakeCursor(cwd, {
        sessionPrompt: {
          dispatch: "immediate",
          steps: [
            {
              expectResult: {
                outcome: {
                  optionId: "frontend",
                  outcome: "selected",
                },
              },
              kind: "request",
              method: "cursor/ask_question",
              params: {
                options: [
                  { id: "frontend", label: "Frontend" },
                  { id: "backend", label: "Backend" },
                ],
                question: "Which area should I focus on?",
                questionId: "question_1",
                sessionId: "__SESSION_ID__",
              },
            },
            {
              kind: "notification",
              method: "session/update",
              params: {
                sessionId: "__SESSION_ID__",
                update: {
                  content: { text: "frontend path", type: "text" },
                  messageId: "msg_1",
                  sessionUpdate: "agent_message_chunk",
                },
              },
            },
          ],
        },
      })

      const runtime = await createCursorRuntimeSession({
        binaryPath: join(binDir, "cursor"),
        cwd,
        env: process.env,
      })

      const requests: Array<{ decisions: string[]; message: string }> = []
      try {
        await expect(
          runtime.run({
            action: "ask",
            cwd,
            interactionHandler: async (request) => {
              if (request.kind !== "approval") {
                throw new Error(`unexpected request kind: ${request.kind}`)
              }
              requests.push({
                decisions: request.decisions.map((decision) => decision.value),
                message: request.message,
              })
              return { decision: "frontend", kind: "approval" }
            },
            prompt: "Ask a follow-up question",
          }),
        ).resolves.toMatchObject({
          exitCode: 0,
          stdout: "frontend path",
          termination: "completed",
        })

        expect(requests).toEqual([
          {
            decisions: ["frontend", "backend"],
            message: "Which area should I focus on?",
          },
        ])
      } finally {
        await runtime.close()
      }
    } finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })

  test("rejects cancelled runs when session/cancel fails before interruption is acknowledged", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "rigg-cursor-runtime-cancel-error-"))

    try {
      const binDir = await installFakeCursor(cwd, {
        sessionCancel: {
          error: {
            message: "cancel rejected",
          },
          steps: [],
        },
        sessionPrompt: {
          dispatch: "immediate",
          steps: [{ kind: "delay", ms: 250 }],
        },
      })

      const runtime = await createCursorRuntimeSession({
        binaryPath: join(binDir, "cursor"),
        cwd,
        env: process.env,
      })

      try {
        const controller = new AbortController()
        const run = runtime.run({
          action: "run",
          cwd,
          prompt: "Interrupt me",
          signal: controller.signal,
        })

        await Bun.sleep(45)
        controller.abort()

        await expect(run).rejects.toThrow("cancel rejected")
      } finally {
        await runtime.close()
      }
    } finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })

  test("ignores late session/update notifications after a cancelled run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "rigg-cursor-runtime-"))

    try {
      const binDir = await installFakeCursor(cwd, {
        sessionCancel: {
          steps: [
            { kind: "delay", ms: 50 },
            {
              kind: "notification",
              method: "session/update",
              params: {
                sessionId: "__SESSION_ID__",
                update: {
                  content: { text: "ignored after cancel", type: "text" },
                  messageId: "msg_cancelled",
                  sessionUpdate: "agent_message_chunk",
                },
              },
            },
          ],
        },
        sessionPrompts: [
          {
            dispatch: "immediate",
            steps: [{ kind: "delay", ms: 250 }],
          },
          {
            dispatch: "immediate",
            steps: [
              {
                kind: "notification",
                method: "session/update",
                params: {
                  sessionId: "__SESSION_ID__",
                  update: {
                    content: { text: "second run", type: "text" },
                    messageId: "msg_2",
                    sessionUpdate: "agent_message_chunk",
                  },
                },
              },
            ],
          },
        ],
      })

      const runtime = await createCursorRuntimeSession({
        binaryPath: join(binDir, "cursor"),
        cwd,
        env: process.env,
      })

      try {
        const controller = new AbortController()
        const firstRun = runtime.run({
          action: "run",
          cwd,
          prompt: "Interrupt me",
          signal: controller.signal,
        })

        await Bun.sleep(45)
        controller.abort()

        await expect(firstRun).resolves.toMatchObject({
          exitCode: 130,
          termination: "interrupted",
        })

        await Bun.sleep(100)

        await expect(
          runtime.run({
            action: "run",
            cwd,
            prompt: "Run again",
          }),
        ).resolves.toMatchObject({
          exitCode: 0,
          stdout: "second run",
          termination: "completed",
        })
      } finally {
        await runtime.close()
      }
    } finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })

  test("ignores late session/update notifications after session/prompt errors", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "rigg-cursor-runtime-prompt-error-"))

    try {
      const binDir = await installFakeCursor(cwd, {
        sessionPrompts: [
          {
            error: {
              message: "prompt rejected",
            },
            respondAfterSteps: false,
            steps: [
              {
                kind: "notification",
                method: "session/update",
                params: {
                  sessionId: "__SESSION_ID__",
                  update: { message: "late failure", sessionUpdate: "error" },
                },
              },
              {
                kind: "notification",
                method: "session/update",
                params: {
                  sessionId: "__SESSION_ID__",
                  update: {
                    content: { text: "too late", type: "text" },
                    messageId: "msg_late",
                    sessionUpdate: "agent_message_chunk",
                  },
                },
              },
            ],
          },
          {
            dispatch: "immediate",
            steps: [
              {
                kind: "notification",
                method: "session/update",
                params: {
                  sessionId: "__SESSION_ID__",
                  update: {
                    content: { text: "second run", type: "text" },
                    messageId: "msg_2",
                    sessionUpdate: "agent_message_chunk",
                  },
                },
              },
            ],
          },
        ],
      })

      const runtime = await createCursorRuntimeSession({
        binaryPath: join(binDir, "cursor"),
        cwd,
        env: process.env,
      })

      try {
        await expect(
          runtime.run({
            action: "run",
            cwd,
            prompt: "Reject this prompt",
          }),
        ).rejects.toThrow("prompt rejected")

        await Bun.sleep(25)

        await expect(
          runtime.run({
            action: "run",
            cwd,
            prompt: "Run again",
          }),
        ).resolves.toMatchObject({
          exitCode: 0,
          stdout: "second run",
          termination: "completed",
        })
      } finally {
        await runtime.close()
      }
    } finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })

  test("maps non-success stop reasons to failed step diagnostics", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "rigg-cursor-runtime-error-update-"))

    try {
      const binDir = await installFakeCursor(cwd, {
        sessionPrompt: {
          dispatch: "immediate",
          response: { stopReason: "refusal" },
          steps: [
            {
              kind: "notification",
              method: "session/update",
              params: {
                sessionId: "__SESSION_ID__",
                update: { message: "cursor provider failed", sessionUpdate: "error" },
              },
            },
          ],
        },
      })

      const runtime = await createCursorRuntimeSession({
        binaryPath: join(binDir, "cursor"),
        cwd,
        env: process.env,
      })

      try {
        await expect(
          runtime.run({
            action: "run",
            cwd,
            prompt: "Refuse with provider error",
          }),
        ).resolves.toMatchObject({
          exitCode: 1,
          stderr: "cursor provider failed",
          termination: "failed",
        })
      } finally {
        await runtime.close()
      }
    } finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })

  test("settles promptly after session/prompt when no trailing updates arrive", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "rigg-cursor-runtime-no-post-response-updates-"))

    try {
      const binDir = await installFakeCursor(cwd, {
        sessionPrompt: {
          dispatch: "immediate",
          steps: [],
        },
      })

      const runtime = await createCursorRuntimeSession({
        binaryPath: join(binDir, "cursor"),
        cwd,
        env: process.env,
      })

      try {
        const startedAt = performance.now()
        const result = await runtime.run({
          action: "run",
          cwd,
          prompt: "Return without late updates",
        })

        expect(result).toMatchObject({
          exitCode: 0,
          stderr: "",
          stdout: "",
          termination: "completed",
        })
        expect(performance.now() - startedAt).toBeLessThan(500)
      } finally {
        await runtime.close()
      }
    } finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })

  test("keeps immediately trailing post-response session/update notifications", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "rigg-cursor-runtime-post-response-updates-"))

    try {
      const binDir = await installFakeCursor(cwd, {
        sessionPrompt: {
          dispatch: "immediate",
          respondAfterSteps: false,
          steps: [
            {
              kind: "notification",
              method: "session/update",
              params: {
                sessionId: "__SESSION_ID__",
                update: {
                  content: { text: "delayed tail", type: "text" },
                  messageId: "msg_1",
                  sessionUpdate: "agent_message_chunk",
                },
              },
            },
            { kind: "delay", ms: 20 },
            {
              kind: "notification",
              method: "session/update",
              params: {
                sessionId: "__SESSION_ID__",
                update: { message: "delayed diagnostic", sessionUpdate: "error" },
              },
            },
          ],
        },
      })

      const runtime = await createCursorRuntimeSession({
        binaryPath: join(binDir, "cursor"),
        cwd,
        env: process.env,
      })

      try {
        await expect(
          runtime.run({
            action: "run",
            cwd,
            prompt: "Wait for immediate post-response updates",
          }),
        ).resolves.toMatchObject({
          exitCode: 0,
          stderr: "delayed diagnostic",
          stdout: "delayed tail",
          termination: "completed",
        })
      } finally {
        await runtime.close()
      }
    } finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })

  test("does not convert completed runs into interrupts during the post-response quiet period", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "rigg-cursor-runtime-post-response-abort-"))

    try {
      const binDir = await installFakeCursor(cwd, {
        sessionPrompt: {
          dispatch: "immediate",
          respondAfterSteps: false,
          steps: [
            { kind: "delay", ms: 20 },
            {
              kind: "notification",
              method: "session/update",
              params: {
                sessionId: "__SESSION_ID__",
                update: {
                  content: { text: "delayed tail", type: "text" },
                  messageId: "msg_1",
                  sessionUpdate: "agent_message_chunk",
                },
              },
            },
            {
              kind: "notification",
              method: "session/update",
              params: {
                sessionId: "__SESSION_ID__",
                update: { message: "delayed diagnostic", sessionUpdate: "error" },
              },
            },
          ],
        },
      })

      const runtime = await createCursorRuntimeSession({
        binaryPath: join(binDir, "cursor"),
        cwd,
        env: process.env,
      })

      try {
        const controller = new AbortController()
        const run = runtime.run({
          action: "run",
          cwd,
          prompt: "Finish before the timeout abort lands",
          signal: controller.signal,
        })

        await Bun.sleep(10)
        controller.abort()

        await expect(run).resolves.toMatchObject({
          exitCode: 0,
          stderr: "delayed diagnostic",
          stdout: "delayed tail",
          termination: "completed",
        })
      } finally {
        await runtime.close()
      }
    } finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })

  test("does not re-enable interruption for ignored post-response session/update notifications", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "rigg-cursor-runtime-post-response-noop-abort-"))

    try {
      const binDir = await installFakeCursor(cwd, {
        sessionPrompt: {
          dispatch: "immediate",
          respondAfterSteps: false,
          steps: [
            { kind: "delay", ms: 20 },
            {
              kind: "notification",
              method: "session/update",
              params: {
                sessionId: "__SESSION_ID__",
                update: {
                  content: { text: "thinking", type: "text" },
                  sessionUpdate: "agent_thought_chunk",
                },
              },
            },
          ],
        },
      })

      const runtime = await createCursorRuntimeSession({
        binaryPath: join(binDir, "cursor"),
        cwd,
        env: process.env,
      })

      try {
        const controller = new AbortController()
        const run = runtime.run({
          action: "run",
          cwd,
          prompt: "Finish even if an ignored update lands before abort",
          signal: controller.signal,
        })

        await Bun.sleep(30)
        controller.abort()

        await expect(run).resolves.toMatchObject({
          exitCode: 0,
          stderr: "",
          stdout: "",
          termination: "completed",
        })
      } finally {
        await runtime.close()
      }
    } finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })

  test("keeps completed runs completed after the last trailing update re-arms settlement", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "rigg-cursor-runtime-post-response-tail-abort-"))

    try {
      const binDir = await installFakeCursor(cwd, {
        sessionPrompt: {
          dispatch: "immediate",
          respondAfterSteps: false,
          steps: [
            { kind: "delay", ms: 20 },
            {
              kind: "notification",
              method: "session/update",
              params: {
                sessionId: "__SESSION_ID__",
                update: {
                  content: { text: "delayed tail", type: "text" },
                  messageId: "msg_1",
                  sessionUpdate: "agent_message_chunk",
                },
              },
            },
          ],
        },
      })

      const runtime = await createCursorRuntimeSession({
        binaryPath: join(binDir, "cursor"),
        cwd,
        env: process.env,
      })

      try {
        const controller = new AbortController()
        const run = runtime.run({
          action: "run",
          cwd,
          prompt: "Finish after the last trailing update lands",
          signal: controller.signal,
        })

        await Bun.sleep(60)
        controller.abort()

        await expect(run).resolves.toMatchObject({
          exitCode: 0,
          stderr: "",
          stdout: "delayed tail",
          termination: "completed",
        })
      } finally {
        await runtime.close()
      }
    } finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })

  test("keeps honoring aborts while a substantive post-response update is still being handled", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "rigg-cursor-runtime-post-response-cancel-"))

    try {
      const binDir = await installFakeCursor(cwd, {
        sessionPrompt: {
          dispatch: "immediate",
          respondAfterSteps: false,
          steps: [
            {
              kind: "notification",
              method: "session/update",
              params: {
                sessionId: "__SESSION_ID__",
                update: {
                  content: { text: "still", type: "text" },
                  messageId: "msg_1",
                  sessionUpdate: "agent_message_chunk",
                },
              },
            },
            { kind: "delay", ms: 200 },
          ],
        },
      })

      const runtime = await createCursorRuntimeSession({
        binaryPath: join(binDir, "cursor"),
        cwd,
        env: process.env,
      })

      try {
        const controller = new AbortController()
        const run = runtime.run({
          action: "run",
          cwd,
          onEvent: async (event) => {
            if (event.kind !== "message_delta") {
              return
            }
            await Bun.sleep(100)
          },
          prompt: "Abort after trailing updates start",
          signal: controller.signal,
        })

        await Bun.sleep(30)
        controller.abort()

        await expect(run).resolves.toMatchObject({
          exitCode: 130,
          stderr: "",
          stdout: "still",
          termination: "interrupted",
        })
      } finally {
        await runtime.close()
      }
    } finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })

  test("does not reopen interruption during the quiet period after a post-response tool call update", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "rigg-cursor-runtime-post-response-tool-call-cancel-"))

    try {
      const binDir = await installFakeCursor(cwd, {
        sessionPrompt: {
          dispatch: "immediate",
          respondAfterSteps: false,
          steps: [
            {
              kind: "notification",
              method: "session/update",
              params: {
                sessionId: "__SESSION_ID__",
                update: {
                  sessionUpdate: "tool_call",
                  status: "pending",
                  title: "Run formatter",
                  toolCallId: "call_1",
                },
              },
            },
            { kind: "delay", ms: 200 },
          ],
        },
        sessionCancel: {
          steps: [
            {
              kind: "notification",
              method: "session/update",
              params: {
                sessionId: "__SESSION_ID__",
                update: {
                  sessionUpdate: "tool_call_update",
                  status: "cancelled",
                  toolCallId: "call_1",
                },
              },
            },
          ],
        },
      })

      const runtime = await createCursorRuntimeSession({
        binaryPath: join(binDir, "cursor"),
        cwd,
        env: process.env,
      })

      try {
        const controller = new AbortController()
        const run = runtime.run({
          action: "run",
          cwd,
          prompt: "Abort after stopReason when a tool call is still pending",
          signal: controller.signal,
        })

        await Bun.sleep(30)
        controller.abort()

        await expect(run).resolves.toMatchObject({
          exitCode: 0,
          stderr: "",
          stdout: "",
          termination: "completed",
        })
      } finally {
        await runtime.close()
      }
    } finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })

  test("ignores delayed session/update notifications after a completed run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "rigg-cursor-runtime-completed-run-late-update-"))

    try {
      const binDir = await installFakeCursor(cwd, {
        sessionPrompts: [
          {
            dispatch: "immediate",
            respondAfterSteps: false,
            steps: [
              {
                kind: "notification",
                method: "session/update",
                params: {
                  sessionId: "__SESSION_ID__",
                  update: {
                    content: { text: "first run", type: "text" },
                    messageId: "msg_1",
                    sessionUpdate: "agent_message_chunk",
                  },
                },
              },
              { kind: "delay", ms: 1_200 },
              {
                kind: "notification",
                method: "session/update",
                params: {
                  sessionId: "__SESSION_ID__",
                  update: {
                    content: { text: "ignored after completion", type: "text" },
                    messageId: "msg_1",
                    sessionUpdate: "agent_message_chunk",
                  },
                },
              },
            ],
          },
          {
            dispatch: "immediate",
            steps: [
              {
                kind: "notification",
                method: "session/update",
                params: {
                  sessionId: "__SESSION_ID__",
                  update: {
                    content: { text: "second run", type: "text" },
                    messageId: "msg_2",
                    sessionUpdate: "agent_message_chunk",
                  },
                },
              },
            ],
          },
        ],
      })

      const runtime = await createCursorRuntimeSession({
        binaryPath: join(binDir, "cursor"),
        cwd,
        env: process.env,
      })

      try {
        await expect(
          runtime.run({
            action: "run",
            cwd,
            prompt: "Complete once",
          }),
        ).resolves.toMatchObject({
          exitCode: 0,
          stdout: "first run",
          termination: "completed",
        })

        await Bun.sleep(300)

        await expect(
          runtime.run({
            action: "run",
            cwd,
            prompt: "Run again",
          }),
        ).resolves.toMatchObject({
          exitCode: 0,
          stdout: "second run",
          termination: "completed",
        })
      } finally {
        await runtime.close()
      }
    } finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })

  test("waits for a delayed session/prompt response after streamed output", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "rigg-cursor-runtime-delayed-prompt-response-"))

    try {
      const binDir = await installFakeCursor(cwd, {
        sessionPrompt: {
          dispatch: "immediate",
          responseDelayMs: 50,
          steps: [
            {
              kind: "notification",
              method: "session/update",
              params: {
                sessionId: "__SESSION_ID__",
                update: {
                  content: { text: "long-running result", type: "text" },
                  messageId: "msg_1",
                  sessionUpdate: "agent_message_chunk",
                },
              },
            },
          ],
        },
      })

      const runtime = await createCursorRuntimeSession({
        binaryPath: join(binDir, "cursor"),
        cwd,
        env: process.env,
      })

      try {
        await expect(
          runtime.run({
            action: "run",
            cwd,
            prompt: "Wait for the prompt response",
          }),
        ).resolves.toMatchObject({
          exitCode: 0,
          stdout: "long-running result",
          termination: "completed",
        })
      } finally {
        await runtime.close()
      }
    } finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })
})
