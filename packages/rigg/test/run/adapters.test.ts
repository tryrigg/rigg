import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import type { ActionNode } from "../../src/compile/schema"
import { createCodexRuntimeSession } from "../../src/codex/runtime"
import { runActionStep } from "../../src/run/adapters"
import { renderContext } from "../fixture/builders"
import { installFakeCodex } from "../fixture/fake-codex"

describe("run/adapters", () => {
  test("runs shell steps with cwd and env", async () => {
    const outputChunks: Array<{ chunk: string; stream: "stderr" | "stdout" }> = []
    const step: ActionNode = {
      type: "shell",
      with: {
        command: "echo $RIGG_TEST_VALUE && pwd",
        result: "text",
      },
    }

    const result = await runActionStep(step, renderContext(), {
      cwd: process.cwd(),
      env: { ...process.env, RIGG_TEST_VALUE: "hello" },
      onOutput: (stream, chunk) => {
        outputChunks.push({ chunk, stream })
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("hello")
    expect(result.stdout).toContain(process.cwd())
    expect(outputChunks.every((chunk) => chunk.stream === "stdout")).toBe(true)
    expect(outputChunks.map((chunk) => chunk.chunk).join("")).toBe(result.stdout)
  })

  test("writes relative files against the provided cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-write-file-"))
    try {
      const step: ActionNode = {
        type: "write_file",
        with: {
          content: "hello",
          path: "nested/output.txt",
        },
      }

      const result = await runActionStep(step, renderContext(), {
        cwd: root,
        env: process.env,
      })

      expect(result.result).toEqual({ path: join(root, "nested/output.txt") })
      expect(await readFile(join(root, "nested/output.txt"), "utf8")).toBe("hello")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("runs codex run steps through app-server", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-codex-run-app-server-"))
    try {
      const binDir = await installFakeCodex(root, {
        turnStart: {
          steps: [
            {
              kind: "notification",
              method: "turn/started",
              params: {
                threadId: "__THREAD_ID__",
                turn: { id: "__TURN_ID__", items: [], status: "inProgress", error: null },
              },
            },
            {
              kind: "notification",
              method: "item/started",
              params: {
                threadId: "__THREAD_ID__",
                turnId: "__TURN_ID__",
                item: {
                  type: "commandExecution",
                  id: "cmd_1",
                  command: "cat src/main.ts",
                  cwd: root,
                  processId: null,
                  status: "inProgress",
                  commandActions: [],
                  aggregatedOutput: null,
                  exitCode: null,
                  durationMs: null,
                },
              },
            },
            {
              kind: "notification",
              method: "codex/event/mcp_startup_complete",
              params: {
                conversationId: "conv_1",
                id: "event_1",
                msg: {
                  type: "mcp_startup_complete",
                  cancelled: [],
                  failed: [],
                  ready: [],
                },
              },
            },
            {
              kind: "notification",
              method: "codex/event/future_event",
              params: {
                conversationId: "conv_1",
                id: "event_2",
                msg: {
                  type: "future_event",
                },
              },
            },
            {
              kind: "notification",
              method: "turn/plan/updated",
              params: {
                threadId: "__THREAD_ID__",
                turnId: "__TURN_ID__",
                steps: [],
              },
            },
            {
              kind: "notification",
              method: "item/agentMessage/delta",
              params: {
                threadId: "__THREAD_ID__",
                turnId: "__TURN_ID__",
                itemId: "msg_1",
                delta: '{"summary":"done"}',
              },
            },
            {
              kind: "notification",
              method: "item/completed",
              params: {
                threadId: "__THREAD_ID__",
                turnId: "__TURN_ID__",
                item: {
                  type: "agentMessage",
                  id: "msg_1",
                  text: '{"summary":"done"}',
                  phase: null,
                },
              },
            },
            {
              kind: "notification",
              method: "turn/completed",
              params: {
                threadId: "__THREAD_ID__",
                turn: { id: "__TURN_ID__", items: [], status: "completed", error: null },
              },
            },
          ],
        },
      })

      const events: Array<Record<string, unknown>> = []
      const result = await runActionStep(
        {
          type: "codex",
          with: {
            action: "run",
            output: {
              schema: {
                additionalProperties: false,
                properties: {
                  summary: { type: "string" },
                },
                required: ["summary"],
                type: "object",
              },
            },
            prompt: "Summarize the change.",
          },
        },
        renderContext(),
        {
          cwd: root,
          env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
          onProviderEvent: (event) => {
            events.push(event as unknown as Record<string, unknown>)
          },
        },
      )

      expect(result.exitCode).toBe(0)
      expect(result.result).toEqual({ summary: "done" })
      expect(events).toEqual([
        { kind: "thread_started", provider: "codex", threadId: "thread_1" },
        { kind: "turn_started", provider: "codex", threadId: "thread_1", turnId: "turn_1" },
        {
          itemId: "cmd_1",
          detail: `command=cat src/main.ts cwd=${root}`,
          kind: "tool_started",
          provider: "codex",
          threadId: "thread_1",
          tool: "command_execution",
          turnId: "turn_1",
        },
        {
          itemId: "msg_1",
          kind: "message_delta",
          provider: "codex",
          text: '{"summary":"done"}',
          threadId: "thread_1",
          turnId: "turn_1",
        },
        {
          itemId: "msg_1",
          kind: "message_completed",
          provider: "codex",
          text: '{"summary":"done"}',
          threadId: "thread_1",
          turnId: "turn_1",
        },
        { kind: "turn_completed", provider: "codex", status: "completed", threadId: "thread_1", turnId: "turn_1" },
      ])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("maps codeReview text back into a review result", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-codex-review-app-server-"))
    try {
      const binDir = await installFakeCodex(root, {
        reviewStart: {
          steps: [
            {
              kind: "notification",
              method: "item/completed",
              params: {
                threadId: "__THREAD_ID__",
                turnId: "__TURN_ID__",
                item: {
                  type: "codeReview",
                  id: "__TURN_ID__",
                  review: [
                    "Looks solid overall with minor polish suggested.",
                    "",
                    "Review comment:",
                    "",
                    "- Prefer Stylize helpers — /tmp/file.rs:10-20",
                    "  Use .dim()/.bold() chaining instead of manual Style.",
                  ].join("\n"),
                },
              },
            },
            {
              kind: "notification",
              method: "turn/completed",
              params: {
                threadId: "__THREAD_ID__",
                turn: { id: "__TURN_ID__", items: [], status: "completed", error: null },
              },
            },
          ],
        },
      })

      const result = await runActionStep(
        {
          type: "codex",
          with: {
            action: "review",
            review: {
              target: {
                type: "uncommitted",
              },
            },
          },
        },
        renderContext(),
        {
          cwd: root,
          env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
        },
      )

      expect(result.exitCode).toBe(0)
      expect(result.result).toEqual({
        findings: [
          {
            body: "Use .dim()/.bold() chaining instead of manual Style.",
            code_location: {
              absolute_file_path: "/tmp/file.rs",
              line_range: {
                end: 20,
                start: 10,
              },
            },
            confidence_score: 0,
            priority: null,
            title: "Prefer Stylize helpers",
          },
        ],
        overall_confidence_score: 0,
        overall_correctness: "unknown",
        overall_explanation: "Looks solid overall with minor polish suggested.",
      })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("resolves approval, user input, and elicitation requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-codex-interactions-"))
    try {
      const binDir = await installFakeCodex(root, {
        turnStart: {
          steps: [
            {
              kind: "request",
              method: "item/commandExecution/requestApproval",
              params: {
                threadId: "__THREAD_ID__",
                turnId: "__TURN_ID__",
                itemId: "cmd_1",
                reason: "Need approval",
                command: "git status",
                cwd: root,
                availableDecisions: ["accept", "decline", "cancel"],
              },
              expectResult: {
                decision: "accept",
              },
            },
            {
              kind: "request",
              method: "item/tool/requestUserInput",
              params: {
                threadId: "__THREAD_ID__",
                turnId: "__TURN_ID__",
                itemId: "input_1",
                questions: [
                  {
                    id: "choice",
                    header: "Choice",
                    question: "Pick one",
                    isOther: false,
                    isSecret: false,
                    options: [{ label: "A", description: "Pick A" }],
                  },
                ],
              },
              expectResult: {
                answers: {
                  choice: {
                    answers: ["A"],
                  },
                },
              },
            },
            {
              kind: "request",
              method: "mcpServer/elicitation/request",
              params: {
                threadId: "__THREAD_ID__",
                turnId: "__TURN_ID__",
                serverName: "search",
                mode: "form",
                message: "Provide parameters",
                requestedSchema: {
                  type: "object",
                  properties: {
                    query: { type: "string" },
                  },
                  required: ["query"],
                },
                _meta: null,
              },
              expectResult: {
                action: "accept",
                content: {
                  query: "hello",
                },
                _meta: null,
              },
            },
            {
              kind: "notification",
              method: "item/completed",
              params: {
                threadId: "__THREAD_ID__",
                turnId: "__TURN_ID__",
                item: {
                  type: "agentMessage",
                  id: "msg_1",
                  text: "done",
                  phase: null,
                },
              },
            },
            {
              kind: "notification",
              method: "turn/completed",
              params: {
                threadId: "__THREAD_ID__",
                turn: { id: "__TURN_ID__", items: [], status: "completed", error: null },
              },
            },
          ],
        },
      })

      const result = await runActionStep(
        {
          type: "codex",
          with: {
            action: "run",
            prompt: "Do the work",
          },
        },
        renderContext(),
        {
          cwd: root,
          env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
          interactionHandler: async (request) => {
            switch (request.kind) {
              case "approval":
                return { decision: "accept", kind: "approval" }
              case "user_input":
                return { answers: { choice: { answers: ["A"] } }, kind: "user_input" }
              case "elicitation":
                return { action: "accept", content: { query: "hello" }, kind: "elicitation" }
            }
          },
        },
      )

      expect(result.exitCode).toBe(0)
      expect(result.result).toBe("done")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("rejects unsupported codex versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-codex-version-gate-"))
    try {
      const binDir = await installFakeCodex(root, {
        versionOutput: "codex-cli 0.113.0",
      })

      await expect(
        runActionStep(
          {
            type: "codex",
            with: {
              action: "run",
              prompt: "Say hi",
            },
          },
          renderContext(),
          {
            cwd: root,
            env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
          },
        ),
      ).rejects.toThrow("Upgrade to v0.114.0 or newer")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("interrupts an active turn through app-server", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-codex-interrupt-"))
    try {
      const binDir = await installFakeCodex(root, {
        turnStart: {
          steps: [],
        },
      })
      const session = await createCodexRuntimeSession({
        cwd: root,
        env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
      })
      const controller = new AbortController()

      const execution = session.run({
        cwd: root,
        signal: controller.signal,
        prompt: "Wait for interruption",
      })

      await new Promise((resolve) => setTimeout(resolve, 50))
      controller.abort()

      await expect(execution).resolves.toMatchObject({
        exitCode: 130,
        termination: "interrupted",
      })
      await session.close()
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
