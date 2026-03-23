import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"

import type { ActionNode } from "../../../src/workflow/schema"
import type { ClaudeProviderEvent } from "../../../src/claude/event"
import type { CodexProviderEvent } from "../../../src/codex/event"
import type { CursorProviderEvent } from "../../../src/cursor/event"
import { createCodexRuntimeSession } from "../../../src/codex/runtime"
import { RIGG_VERSION } from "../../../src/version"
import { runActionStep } from "../../../src/session/step"
import { renderContext } from "../../fixture/builders"
import { createFakeClaudeSdk, installFakeClaude } from "../../fixture/fake-claude"
import { installFakeCodex } from "../../fixture/fake-codex"
import { installFakeCursor } from "../../fixture/fake-cursor"

const FAKE_CODEX_LIFECYCLE_LOG = ".fake-codex-app-server-events.log"

function claudeResult(text: string): SDKMessage {
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
    session_id: "session_1",
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
    uuid: "00000000-0000-4000-8000-000000000001",
  } as unknown as SDKMessage
}

async function readFakeCodexLifecycleEvents(root: string): Promise<string[]> {
  try {
    const contents = await readFile(join(root, FAKE_CODEX_LIFECYCLE_LOG), "utf8")
    return contents
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return []
    }
    throw error
  }
}

async function waitForFakeCodexExitEvents(root: string, expectedCount: number): Promise<string[]> {
  const timeoutAt = Date.now() + 1_000
  while (Date.now() < timeoutAt) {
    const events = await readFakeCodexLifecycleEvents(root)
    const exitCount = events.filter((line) => line.startsWith("exit:")).length
    if (exitCount >= expectedCount) {
      return events
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  return await readFakeCodexLifecycleEvents(root)
}

async function runBunScript(
  scriptPath: string,
  env: Record<string, string | undefined>,
): Promise<{ code: number | null; durationMs: number; stderr: string }> {
  const startedAt = Date.now()
  const child = spawn(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "ignore", "pipe"],
  })

  let stderr = ""
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString()
  })

  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (nextCode) => resolve(nextCode))
  })

  return {
    code,
    durationMs: Date.now() - startedAt,
    stderr,
  }
}

describe("session/step", () => {
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
        threadStartExpectParams: {
          cwd: root,
          experimentalRawEvents: false,
          model: null,
          persistExtendedHistory: false,
        },
        turnStart: {
          expectParams: {
            effort: "medium",
            input: [{ text: "Summarize the change.", text_elements: [], type: "text" }],
            model: null,
            threadId: "__THREAD_ID__",
          },
          dispatch: "immediate",
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
                delta: "done",
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

      const events: CodexProviderEvent[] = []
      const result = await runActionStep(
        {
          type: "codex",
          with: {
            kind: "turn",
            prompt: "Summarize the change.",
          },
        },
        renderContext(),
        {
          cwd: root,
          env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
          onProviderEvent: (event) => {
            if (event.provider === "codex") {
              events.push(event)
            }
          },
        },
      )

      expect(result.exitCode).toBe(0)
      expect(result.result).toBe("done")
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
          text: "done",
          threadId: "thread_1",
          turnId: "turn_1",
        },
        {
          itemId: "msg_1",
          kind: "message_completed",
          provider: "codex",
          text: "done",
          threadId: "thread_1",
          turnId: "turn_1",
        },
        { kind: "turn_completed", provider: "codex", status: "completed", threadId: "thread_1", turnId: "turn_1" },
      ])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("preserves streamed codex text when agent completion omits text", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-codex-run-streamed-app-server-"))
    try {
      const binDir = await installFakeCodex(root, {
        turnStart: {
          steps: [
            {
              kind: "notification",
              method: "item/agentMessage/delta",
              params: {
                threadId: "__THREAD_ID__",
                turnId: "__TURN_ID__",
                itemId: "msg_1",
                delta: "do",
              },
            },
            {
              kind: "notification",
              method: "item/agentMessage/delta",
              params: {
                threadId: "__THREAD_ID__",
                turnId: "__TURN_ID__",
                itemId: "msg_1",
                delta: "ne",
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

      const events: CodexProviderEvent[] = []
      const result = await runActionStep(
        {
          type: "codex",
          with: {
            kind: "turn",
            prompt: "Summarize the change.",
          },
        },
        renderContext(),
        {
          cwd: root,
          env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
          onProviderEvent: (event) => {
            if (event.provider === "codex") {
              events.push(event)
            }
          },
        },
      )

      expect(result.exitCode).toBe(0)
      expect(result.result).toBe("done")
      expect(result.stdout).toBe("done")
      expect(events).toEqual([
        { kind: "thread_started", provider: "codex", threadId: "thread_1" },
        { kind: "turn_started", provider: "codex", threadId: "thread_1", turnId: "turn_1" },
        {
          itemId: "msg_1",
          kind: "message_delta",
          provider: "codex",
          text: "do",
          threadId: "thread_1",
          turnId: "turn_1",
        },
        {
          itemId: "msg_1",
          kind: "message_delta",
          provider: "codex",
          text: "ne",
          threadId: "thread_1",
          turnId: "turn_1",
        },
        {
          itemId: "msg_1",
          kind: "message_completed",
          provider: "codex",
          text: "done",
          threadId: "thread_1",
          turnId: "turn_1",
        },
        { kind: "turn_completed", provider: "codex", status: "completed", threadId: "thread_1", turnId: "turn_1" },
      ])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("runs codex run steps with an effort override through direct turn/start overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-codex-run-effort-app-server-"))
    try {
      const binDir = await installFakeCodex(root, {
        threadStartExpectParams: {
          cwd: root,
          experimentalRawEvents: false,
          model: null,
          persistExtendedHistory: false,
        },
        turnStart: {
          expectParams: {
            effort: "high",
            input: [{ text: "Summarize the change.", text_elements: [], type: "text" }],
            model: null,
            threadId: "__THREAD_ID__",
          },
          steps: [
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
            kind: "turn",
            effort: "high",
            prompt: "Summarize the change.",
          },
        },
        renderContext(),
        {
          cwd: root,
          env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
        },
      )

      expect(result.exitCode).toBe(0)
      expect(result.result).toBe("done")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("maps codeReview text back into a review result", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-codex-review-app-server-"))
    try {
      const binDir = await installFakeCodex(root, {
        threadStartExpectParams: {
          cwd: root,
          experimentalRawEvents: false,
          model: null,
          persistExtendedHistory: false,
        },
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
            kind: "review",
            target: {
              type: "uncommitted",
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

  test("runs codex plan steps with the built-in collaboration mode and default medium effort", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-codex-plan-app-server-"))
    try {
      const binDir = await installFakeCodex(root, {
        initializeExpectParams: {
          capabilities: {
            experimentalApi: true,
          },
          clientInfo: {
            name: "@tryrigg/rigg",
            title: "Rigg",
            version: RIGG_VERSION,
          },
        },
        threadStartExpectParams: {
          cwd: root,
          experimentalRawEvents: false,
          model: null,
          persistExtendedHistory: false,
        },
        collaborationModeListResult: {
          data: [
            { name: "Plan", mode: "plan", model: null, reasoning_effort: "high" },
            { name: "Default", mode: "default", model: null, reasoning_effort: null },
          ],
        },
        turnStart: {
          expectParams: {
            collaborationMode: {
              mode: "plan",
              settings: {
                developer_instructions: null,
                model: "gpt-5.5",
                reasoning_effort: "medium",
              },
            },
            input: [{ text: "Ask one clarifying question, then return the plan.", text_elements: [], type: "text" }],
            threadId: "__THREAD_ID__",
          },
          steps: [
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
              kind: "notification",
              method: "item/completed",
              params: {
                threadId: "__THREAD_ID__",
                turnId: "__TURN_ID__",
                item: {
                  type: "agentMessage",
                  id: "msg_1",
                  text: "plan ready",
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
            kind: "turn",
            collaboration_mode: "plan",
            model: "gpt-5.5",
            prompt: "Ask one clarifying question, then return the plan.",
          },
        },
        renderContext(),
        {
          cwd: root,
          env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
          interactionHandler: async (request) => {
            if (request.kind !== "user_input") {
              throw new Error(`unexpected interaction ${request.kind}`)
            }

            return {
              answers: {
                choice: { answers: ["A"] },
              },
              kind: "user_input",
            }
          },
        },
      )

      expect(result.exitCode).toBe(0)
      expect(result.result).toBe("plan ready")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("runs codex plan steps with an effort override", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-codex-plan-effort-app-server-"))
    try {
      const binDir = await installFakeCodex(root, {
        threadStartExpectParams: {
          cwd: root,
          experimentalRawEvents: false,
          model: null,
          persistExtendedHistory: false,
        },
        collaborationModeListResult: {
          data: [
            { name: "Plan", mode: "plan", model: "gpt-5.4", reasoning_effort: "medium" },
            { name: "Default", mode: "default", model: "gpt-5.4", reasoning_effort: null },
          ],
        },
        turnStart: {
          expectParams: {
            collaborationMode: {
              mode: "plan",
              settings: {
                developer_instructions: null,
                model: "gpt-5.4",
                reasoning_effort: "xhigh",
              },
            },
            input: [{ text: "Return the plan.", text_elements: [], type: "text" }],
            threadId: "__THREAD_ID__",
          },
          steps: [
            {
              kind: "notification",
              method: "item/completed",
              params: {
                threadId: "__THREAD_ID__",
                turnId: "__TURN_ID__",
                item: {
                  type: "agentMessage",
                  id: "msg_1",
                  text: "plan ready",
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
            kind: "turn",
            collaboration_mode: "plan",
            effort: "xhigh",
            prompt: "Return the plan.",
          },
        },
        renderContext(),
        {
          cwd: root,
          env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
        },
      )

      expect(result.exitCode).toBe(0)
      expect(result.result).toBe("plan ready")
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
              method: "item/permissions/requestApproval",
              params: {
                threadId: "__THREAD_ID__",
                turnId: "__TURN_ID__",
                itemId: "perm_1",
                reason: "Need permissions",
                permissions: {
                  fileSystem: {
                    read: null,
                    write: [root],
                  },
                  network: null,
                },
              },
              expectResult: {
                permissions: {
                  fileSystem: {
                    read: null,
                    write: [root],
                  },
                  network: null,
                },
                scope: "turn",
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
            kind: "turn",
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
                return {
                  decision: request.decisions.find((decision) => decision.intent === "approve")?.value ?? "decline",
                  kind: "approval",
                }
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
              kind: "turn",
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

  test("cleans up the app-server when bootstrap fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-codex-bootstrap-failure-"))
    try {
      const binDir = await installFakeCodex(root, {
        accountReadResult: {
          account: null,
          requiresOpenaiAuth: true,
        },
      })

      await expect(
        createCodexRuntimeSession({
          cwd: root,
          env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
        }),
      ).rejects.toThrow("Codex CLI is not authenticated")

      await expect(
        createCodexRuntimeSession({
          cwd: root,
          env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
        }),
      ).rejects.toThrow("Codex CLI is not authenticated")

      const lifecycleEvents = await waitForFakeCodexExitEvents(root, 2)
      expect(lifecycleEvents.filter((line) => line.startsWith("started:"))).toHaveLength(2)
      expect(lifecycleEvents.filter((line) => line.startsWith("exit:"))).toHaveLength(2)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("closes the app-server without lingering for the forced-kill grace period", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-codex-close-latency-"))
    try {
      const binDir = await installFakeCodex(root, {})
      const scriptPath = join(root, "close-codex-session.ts")
      const processModuleUrl = new URL("../../../src/codex/proc.ts", import.meta.url).href

      await writeFile(
        scriptPath,
        [
          `const { startServer } = await import(${JSON.stringify(processModuleUrl)});`,
          `const appServer = startServer({`,
          `  cwd: ${JSON.stringify(root)},`,
          `  env: process.env,`,
          `});`,
          `await appServer.close();`,
        ].join("\n"),
        "utf8",
      )

      const result = await runBunScript(scriptPath, {
        ...process.env,
        PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
      })
      expect(result.code).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.durationMs).toBeLessThan(700)
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

  test("completes interruption when app-server acknowledges without turn completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-codex-interrupt-ack-only-"))
    try {
      const binDir = await installFakeCodex(root, {
        turnInterrupt: {
          steps: [],
        },
        turnStart: {
          steps: [],
        },
      })
      const session = await createCodexRuntimeSession({
        cwd: root,
        env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
      })
      const controller = new AbortController()
      const startedAt = Date.now()

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
      expect(Date.now() - startedAt).toBeLessThan(700)
      await session.close()
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("completes interruption when app-server never responds to turn/interrupt", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-codex-interrupt-no-response-"))
    try {
      const binDir = await installFakeCodex(root, {
        turnInterrupt: {
          respond: false,
          steps: [],
        },
        turnStart: {
          steps: [],
        },
      })
      const session = await createCodexRuntimeSession({
        cwd: root,
        env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
      })
      const controller = new AbortController()
      const startedAt = Date.now()

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
      expect(Date.now() - startedAt).toBeLessThan(1_500)
      await session.close()
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("fails an active turn on malformed app-server output", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-codex-malformed-json-"))
    try {
      const binDir = await installFakeCodex(root, {
        turnStart: {
          dispatch: "immediate",
          steps: [{ kind: "stdout", text: "{not-json" }],
        },
      })
      const session = await createCodexRuntimeSession({
        cwd: root,
        env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
      })

      await expect(
        session.run({
          cwd: root,
          prompt: "Trigger malformed output",
        }),
      ).rejects.toThrow("codex app-server returned invalid JSON")

      await session.close()
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("cancels delayed thread startup promptly", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-codex-thread-start-abort-"))
    try {
      const binDir = await installFakeCodex(root, {
        threadStartDelayMs: 1_000,
        turnStart: {
          steps: [],
        },
      })
      const session = await createCodexRuntimeSession({
        cwd: root,
        env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
      })
      const controller = new AbortController()
      const startedAt = Date.now()

      const execution = session.run({
        cwd: root,
        prompt: "Abort before thread start returns",
        signal: controller.signal,
      })

      await new Promise((resolve) => setTimeout(resolve, 50))
      controller.abort()

      await expect(execution).resolves.toMatchObject({
        exitCode: 130,
        termination: "interrupted",
      })
      expect(Date.now() - startedAt).toBeLessThan(700)

      await session.close()
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("uses dedicated app-server sessions for concurrent codex steps", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-codex-dedicated-sessions-"))
    try {
      const binDir = await installFakeCodex(root, {
        turnStart: {
          dispatch: "immediate",
          steps: [
            { kind: "stderr", text: "dedicated session diagnostic" },
            { kind: "delay", ms: 50 },
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

      const step: ActionNode = {
        type: "codex",
        with: {
          kind: "turn",
          prompt: "run in isolated session",
        },
      }

      const [first, second] = await Promise.all([
        runActionStep(step, renderContext(), {
          cwd: root,
          env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
        }),
        runActionStep(step, renderContext(), {
          cwd: root,
          env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
        }),
      ])

      expect(first.stderr).toBe("dedicated session diagnostic")
      expect(second.stderr).toBe("dedicated session diagnostic")
      expect(first.providerEvents).toContainEqual({
        kind: "diagnostic",
        message: "dedicated session diagnostic",
        provider: "codex",
        threadId: "thread_1",
        turnId: "turn_1",
      })
      expect(second.providerEvents).toContainEqual({
        kind: "diagnostic",
        message: "dedicated session diagnostic",
        provider: "codex",
        threadId: "thread_1",
        turnId: "turn_1",
      })

      const lifecycleEvents = await waitForFakeCodexExitEvents(root, 2)
      expect(lifecycleEvents.filter((line) => line.startsWith("started:"))).toHaveLength(2)
      expect(lifecycleEvents.filter((line) => line.startsWith("exit:"))).toHaveLength(2)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("runs claude steps through the runtime and maps snake_case options", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-claude-step-"))
    try {
      const binDir = await installFakeClaude(root)
      const events: ClaudeProviderEvent[] = []
      const { sdk, state } = createFakeClaudeSdk({
        messages: [claudeResult("done")],
      })

      const result = await runActionStep(
        {
          type: "claude",
          with: {
            effort: "high",
            max_thinking_tokens: 12000,
            max_turns: 8,
            model: "claude-opus-4-6",
            permission_mode: "accept_edits",
            prompt: "Implement the change.",
          },
        },
        renderContext(),
        {
          claudeSdk: sdk,
          cwd: root,
          env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
          onProviderEvent: (event) => {
            if (event.provider === "claude") {
              events.push(event)
            }
          },
        },
      )

      expect(result.exitCode).toBe(0)
      expect(result.result).toBe("done")
      expect(events).toEqual([
        {
          kind: "session_completed",
          provider: "claude",
          sessionId: "session_1",
          status: "completed",
        },
      ])
      expect(state.queries[0]).toMatchObject({
        cwd: root,
        effort: "high",
        maxThinkingTokens: 12000,
        maxTurns: 8,
        model: "claude-opus-4-6",
        permissionMode: "acceptEdits",
      })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("uses separate claude sessions for concurrent steps", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-claude-concurrent-"))
    try {
      const binDir = await installFakeClaude(root)
      const { sdk, state } = createFakeClaudeSdk({
        onQuery: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50))
          return [claudeResult("done")]
        },
      })
      const step: ActionNode = {
        type: "claude",
        with: {
          prompt: "run in isolated session",
        },
      }

      const [first, second] = await Promise.all([
        runActionStep(step, renderContext(), {
          claudeSdk: sdk,
          cwd: root,
          env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
        }),
        runActionStep(step, renderContext(), {
          claudeSdk: sdk,
          cwd: root,
          env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
        }),
      ])

      expect(first.result).toBe("done")
      expect(second.result).toBe("done")
      expect(state.queries).toHaveLength(2)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("rejects unsupported claude versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-claude-version-gate-"))
    try {
      const binDir = await installFakeClaude(root, {
        versionOutput: "claude 2.1.75",
      })

      await expect(
        runActionStep(
          {
            type: "claude",
            with: {
              prompt: "Say hi",
            },
          },
          renderContext(),
          {
            cwd: root,
            env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
          },
        ),
      ).rejects.toThrow("Upgrade to v2.1.76 or newer")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  const cursorPromptCases: Array<{
    expectedMode: "agent" | "ask" | "plan"
    mode: "agent" | "ask" | "plan"
    text: string
  }> = [
    { mode: "agent", expectedMode: "agent", text: "cursor run output" },
    { mode: "plan", expectedMode: "plan", text: "cursor plan output" },
    { mode: "ask", expectedMode: "ask", text: "cursor ask output" },
  ]

  test.each(cursorPromptCases)("runs cursor $mode steps through ACP", async ({ mode, expectedMode, text }) => {
    const root = await mkdtemp(join(tmpdir(), `rigg-cursor-${mode}-acp-`))
    try {
      const binDir = await installFakeCursor(root, {
        initializeExpectParams: {
          clientCapabilities: {},
          clientInfo: {
            name: "@tryrigg/rigg",
            title: "Rigg",
            version: RIGG_VERSION,
          },
          protocolVersion: 1,
        },
        sessionNew: {
          expectParams: {
            cwd: root,
            mcpServers: [],
            mode: expectedMode,
          },
        },
        sessionPrompt: {
          dispatch: "immediate",
          expectParams: {
            prompt: [{ text: `Prompt for ${mode}`, type: "text" }],
            sessionId: "__SESSION_ID__",
          },
          steps: [
            {
              kind: "notification",
              method: "session/update",
              params: {
                sessionId: "__SESSION_ID__",
                update: {
                  content: { text: text.slice(0, Math.floor(text.length / 2)), type: "text" },
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
                update: {
                  content: { text: text.slice(Math.floor(text.length / 2)), type: "text" },
                  messageId: "msg_1",
                  sessionUpdate: "agent_message_chunk",
                },
              },
            },
          ],
        },
      })

      const events: CursorProviderEvent[] = []
      const result = await runActionStep(
        {
          type: "cursor",
          with: {
            mode,
            prompt: `Prompt for ${mode}`,
          },
        },
        renderContext(),
        {
          cwd: root,
          env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
          onProviderEvent: (event) => {
            if (event.provider === "cursor") {
              events.push(event)
            }
          },
        },
      )

      expect(result.exitCode).toBe(0)
      expect(result.result).toBe(text)
      expect(events).toEqual([
        {
          cwd: root,
          kind: "session_started",
          mode,
          provider: "cursor",
          sessionId: "session_1",
        },
        {
          kind: "message_delta",
          messageId: "msg_1",
          provider: "cursor",
          sessionId: "session_1",
          text: text.slice(0, Math.floor(text.length / 2)),
        },
        {
          kind: "message_delta",
          messageId: "msg_1",
          provider: "cursor",
          sessionId: "session_1",
          text: text.slice(Math.floor(text.length / 2)),
        },
        {
          kind: "session_completed",
          provider: "cursor",
          sessionId: "session_1",
          status: "completed",
        },
      ])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("round-trips standard ACP cursor permission requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-cursor-permission-acp-"))
    try {
      const binDir = await installFakeCursor(root, {
        sessionPrompt: {
          dispatch: "immediate",
          steps: [
            {
              expectResult: {
                outcome: {
                  optionId: "code",
                  outcome: "selected",
                },
              },
              kind: "request",
              method: "session/request_permission",
              params: {
                options: [
                  {
                    kind: "allow_always",
                    name: "Yes, and auto-accept all actions",
                    optionId: "code",
                  },
                  {
                    kind: "allow_once",
                    name: "Yes, and manually accept actions",
                    optionId: "ask",
                  },
                  {
                    kind: "reject_once",
                    name: "No, stay in architect mode",
                    optionId: "reject",
                  },
                ],
                sessionId: "__SESSION_ID__",
                toolCall: {
                  content: [{ text: "## Implementation Plan...", type: "text" }],
                  kind: "switch_mode",
                  status: "pending",
                  title: "Ready for implementation",
                  toolCallId: "call_switch_mode_001",
                },
              },
            },
            {
              kind: "notification",
              method: "session/update",
              params: {
                sessionId: "__SESSION_ID__",
                update: {
                  content: { text: "approved", type: "text" },
                  messageId: "msg_1",
                  sessionUpdate: "agent_message_chunk",
                },
              },
            },
          ],
        },
      })

      const requests: Array<{ decisions: string[]; message: string }> = []
      const result = await runActionStep(
        {
          type: "cursor",
          with: {
            mode: "agent",
            prompt: "Needs approval",
          },
        },
        renderContext(),
        {
          cwd: root,
          env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
          interactionHandler: (request) => {
            if (request.kind !== "approval") {
              throw new Error(`unexpected request kind: ${request.kind}`)
            }
            requests.push({
              decisions: request.decisions.map((decision) => decision.value),
              message: request.message,
            })
            return { decision: "code", kind: "approval" }
          },
        },
      )

      expect(result.result).toBe("approved")
      expect(requests).toEqual([
        {
          decisions: ["code", "ask", "reject"],
          message: "Ready for implementation\n\n## Implementation Plan...",
        },
      ])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("interrupts cursor sessions with session/cancel", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-cursor-interrupt-"))
    try {
      const binDir = await installFakeCursor(root, {
        sessionPrompt: {
          dispatch: "immediate",
          steps: [{ kind: "delay", ms: 500 }],
        },
      })

      const controller = new AbortController()
      const execution = runActionStep(
        {
          type: "cursor",
          with: {
            mode: "agent",
            prompt: "Interrupt me",
          },
        },
        renderContext(),
        {
          cwd: root,
          env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
          signal: controller.signal,
        },
      )

      await new Promise((resolve) => setTimeout(resolve, 50))
      controller.abort()

      await expect(execution).resolves.toMatchObject({
        exitCode: 130,
        termination: "interrupted",
      })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
