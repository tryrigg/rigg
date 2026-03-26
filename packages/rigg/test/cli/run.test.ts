import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  buildQuestion,
  createInterrupt,
  resolveWorkflowResult,
  runCommand,
  type Dependencies,
  type InterruptController,
  type RunCommandOptions,
} from "../../src/cli/run"
import type { RunSession } from "../../src/cli/session"
import type { RunWorkflowResult } from "../../src/session/api"
import { interrupt } from "../../src/session/error"
import type { RunControlRequest } from "../../src/session/event"
import { runSnapshot, workflowProject } from "../fixture/builders"

type RunWorkflowOptions = Parameters<Dependencies["runWorkflowImpl"]>[0]
type CreateRunSessionOptions = Parameters<Dependencies["createRunSession"]>[0]

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

async function createTempWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rigg-cli-"))
  tempDirs.push(path)
  return path
}

async function writeWorkflow(cwd: string, fileName: string, contents: string): Promise<void> {
  await mkdir(join(cwd, ".rigg"), { recursive: true })
  await Bun.write(join(cwd, ".rigg", fileName), contents)
}

function runOptions(overrides: Partial<RunCommandOptions> = {}): RunCommandOptions {
  return {
    autoContinue: false,
    inputs: [],
    mode: { kind: "interactive" },
    ...overrides,
  }
}

function stubInterruptController(): InterruptController {
  const controller = new AbortController()
  return {
    dispose: () => {},
    interrupt: () => controller.abort(interrupt("workflow interrupted by operator")),
    signal: controller.signal,
  }
}

function stubRunSession(overrides: Partial<RunSession> = {}): RunSession {
  return {
    close: () => {},
    emit: () => {},
    handle: async () => {
      throw new Error("unexpected control request")
    },
    ...overrides,
  }
}

function stubDeps(overrides: Partial<Dependencies> = {}): Partial<Dependencies> {
  return overrides
}

function completed(snapshot = runSnapshot()): RunWorkflowResult {
  return { kind: "completed", snapshot }
}

function withTTYState(tty: { stderr: boolean; stdin: boolean }, run: () => Promise<void> | void): Promise<void> | void {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
  const stderrDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY")

  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: tty.stdin })
  Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: tty.stderr })

  const restore = () => {
    if (stdinDescriptor === undefined) {
      delete (process.stdin as { isTTY?: boolean }).isTTY
    } else {
      Object.defineProperty(process.stdin, "isTTY", stdinDescriptor)
    }
    if (stderrDescriptor === undefined) {
      delete (process.stderr as { isTTY?: boolean }).isTTY
    } else {
      Object.defineProperty(process.stderr, "isTTY", stderrDescriptor)
    }
  }

  try {
    const result = run()
    if (result instanceof Promise) {
      return result.finally(restore)
    }
    restore()
    return result
  } catch (error) {
    restore()
    throw error
  }
}

describe("cli/run", () => {
  test("requires interactive stdin and stderr", async () => {
    const cwd = await createTempWorkspace()
    await writeWorkflow(
      cwd,
      "plan.yaml",
      ["id: plan", "steps:", "  - type: shell", "    with:", "      command: echo hi"].join("\n"),
    )

    await withTTYState({ stderr: true, stdin: false }, async () => {
      const result = await runCommand(cwd, "plan", runOptions())
      expect(result.exitCode).toBe(1)
      expect(result.stderrLines).toEqual([
        "`rigg run` requires a TTY because step barriers and workflow input prompts are interactive. Re-run in an interactive terminal. `--auto-continue` only works in an interactive terminal.",
      ])
    })
  })

  test("run --auto-continue is still rejected without a TTY", async () => {
    const cwd = await createTempWorkspace()
    await writeWorkflow(
      cwd,
      "plan.yaml",
      ["id: plan", "steps:", "  - type: shell", "    with:", "      command: echo hi"].join("\n"),
    )

    await withTTYState({ stderr: false, stdin: true }, async () => {
      const result = await runCommand(cwd, "plan", runOptions({ autoContinue: true }))
      expect(result.exitCode).toBe(1)
      expect(result.stderrLines).toEqual([
        "`rigg run` requires a TTY because step barriers and workflow input prompts are interactive. Re-run in an interactive terminal. `--auto-continue` only works in an interactive terminal.",
      ])
    })
  })

  test("tty run --auto-continue passes auto barrier mode into the session factory", async () => {
    const cwd = await createTempWorkspace()
    await writeWorkflow(
      cwd,
      "prompt.yaml",
      ["id: prompt", "steps:", "  - type: shell", "    with:", "      command: echo hi"].join("\n"),
    )

    await withTTYState({ stderr: true, stdin: true }, async () => {
      const createRunSessionCalls: string[] = []

      const result = await runCommand(
        cwd,
        "prompt",
        runOptions({ autoContinue: true }),
        stubDeps({
          createInterruptController: stubInterruptController,
          createRunSession: (options: CreateRunSessionOptions) => {
            createRunSessionCalls.push(options.barrierMode)
            return stubRunSession()
          },
          runWorkflowImpl: async () =>
            completed(
              runSnapshot({
                finished_at: "2026-03-17T00:00:02.000Z",
                phase: "completed",
                reason: "completed",
                status: "succeeded",
                workflow_id: "prompt",
              }),
            ),
        }),
      )

      expect(result.exitCode).toBe(0)
      expect(createRunSessionCalls).toEqual(["auto_continue"])
    })
  })

  test("headless run skips the tty guard and uses the headless session factory", async () => {
    const cwd = await createTempWorkspace()
    await writeWorkflow(
      cwd,
      "prompt.yaml",
      ["id: prompt", "steps:", "  - type: shell", "    with:", "      command: echo hi"].join("\n"),
    )

    await withTTYState({ stderr: false, stdin: false }, async () => {
      let headlessSessionCalls = 0

      const result = await runCommand(
        cwd,
        "prompt",
        runOptions({ mode: { kind: "headless_text", verbose: false } }),
        stubDeps({
          createHeadlessSession: () => {
            headlessSessionCalls += 1
            return stubRunSession()
          },
          createRunSession: () => {
            throw new Error("interactive session should not be created in headless mode")
          },
          runWorkflowImpl: async () =>
            completed(
              runSnapshot({
                finished_at: "2026-03-17T00:00:02.000Z",
                phase: "completed",
                reason: "completed",
                status: "succeeded",
                workflow_id: "prompt",
              }),
            ),
        }),
      )

      expect(result.exitCode).toBe(0)
      expect(headlessSessionCalls).toBe(1)
    })
  })

  test("headless preflight fails missing required inputs before runWorkflow", async () => {
    const cwd = await createTempWorkspace()
    await writeWorkflow(
      cwd,
      "prompt.yaml",
      [
        "id: prompt",
        "inputs:",
        "  name:",
        "    type: string",
        "  count:",
        "    type: integer",
        "steps:",
        "  - type: shell",
        "    with:",
        "      command: echo hi",
      ].join("\n"),
    )

    await withTTYState({ stderr: false, stdin: false }, async () => {
      let runWorkflowCalls = 0

      const result = await runCommand(
        cwd,
        "prompt",
        runOptions({ mode: { kind: "headless_text", verbose: false } }),
        stubDeps({
          createHeadlessSession: () => stubRunSession(),
          runWorkflowImpl: (async () => {
            runWorkflowCalls += 1
            throw new Error("runWorkflow should not be called")
          }) as Dependencies["runWorkflowImpl"],
        }),
      )

      expect(result.exitCode).toBe(1)
      expect(result.stderrLines).toEqual(["Missing required workflow inputs: name, count."])
      expect(runWorkflowCalls).toBe(0)
    })
  })

  test("headless json preflight failures stay machine-readable", async () => {
    const cwd = await createTempWorkspace()
    await writeWorkflow(
      cwd,
      "prompt.yaml",
      [
        "id: prompt",
        "inputs:",
        "  name:",
        "    type: string",
        "steps:",
        "  - type: shell",
        "    with:",
        "      command: echo hi",
      ].join("\n"),
    )

    await withTTYState({ stderr: false, stdin: false }, async () => {
      const result = await runCommand(cwd, "prompt", runOptions({ mode: { kind: "headless_json" } }))

      expect(result.exitCode).toBe(1)
      expect(result.stderrLines).toEqual([])
      expect(result.stdoutLines).toEqual([
        '{"errors":["Missing required workflow inputs: name."],"status":"failed","warnings":[]}',
      ])
    })
  })

  test("headless stream-json preflight failures stay machine-readable", async () => {
    const cwd = await createTempWorkspace()
    await writeWorkflow(
      cwd,
      "prompt.yaml",
      [
        "id: prompt",
        "inputs:",
        "  name:",
        "    type: string",
        "steps:",
        "  - type: shell",
        "    with:",
        "      command: echo hi",
      ].join("\n"),
    )

    await withTTYState({ stderr: false, stdin: false }, async () => {
      const result = await runCommand(cwd, "prompt", runOptions({ mode: { kind: "headless_stream_json" } }))

      expect(result.exitCode).toBe(1)
      expect(result.stderrLines).toEqual([])
      expect(result.stdoutLines).toEqual(['{"errors":["Missing required workflow inputs: name."],"kind":"error"}'])
    })
  })

  test("headless preflight merges workflow defaults without prompting", async () => {
    const cwd = await createTempWorkspace()
    await writeWorkflow(
      cwd,
      "prompt.yaml",
      [
        "id: prompt",
        "inputs:",
        "  name:",
        "    type: string",
        "    default: Rigg",
        "  retries:",
        "    type: integer",
        "    default: 2",
        "steps:",
        "  - type: shell",
        "    with:",
        "      command: echo hi",
      ].join("\n"),
    )

    await withTTYState({ stderr: false, stdin: false }, async () => {
      const runWorkflowCalls: Array<Record<string, unknown>> = []

      const result = await runCommand(
        cwd,
        "prompt",
        runOptions({ mode: { kind: "headless_text", verbose: false } }),
        stubDeps({
          createHeadlessSession: () => stubRunSession(),
          createRunSession: () => {
            throw new Error("interactive session should not be created in headless mode")
          },
          runWorkflowImpl: async (options: RunWorkflowOptions) => {
            runWorkflowCalls.push(options.invocationInputs)
            return completed(
              runSnapshot({
                finished_at: "2026-03-17T00:00:02.000Z",
                phase: "completed",
                reason: "completed",
                status: "succeeded",
                workflow_id: "prompt",
              }),
            )
          },
        }),
      )

      expect(result.exitCode).toBe(0)
      expect(runWorkflowCalls).toEqual([
        {
          name: "Rigg",
          retries: 2,
        },
      ])
    })
  })

  test("resolveWorkflowResult summarizes run snapshots", () => {
    const cases = [
      {
        expected: {
          error: null,
          lastPath: "/1/0",
          resultPath: "/1",
          result: "done",
          status: "succeeded",
        },
        snapshot: runSnapshot({
          finished_at: "2026-03-17T00:00:03.000Z",
          nodes: [
            {
              attempt: 1,
              duration_ms: 1000,
              exit_code: 0,
              finished_at: "2026-03-17T00:00:01.000Z",
              node_kind: "shell",
              node_path: "/0",
              result: "first",
              started_at: "2026-03-17T00:00:00.000Z",
              status: "succeeded",
              stderr: null,
              stdout: null,
              user_id: "build",
              waiting_for: null,
            },
            {
              attempt: 1,
              duration_ms: 2000,
              exit_code: null,
              finished_at: "2026-03-17T00:00:03.000Z",
              node_kind: "group",
              node_path: "/1",
              result: "done",
              started_at: "2026-03-17T00:00:01.000Z",
              status: "succeeded",
              stderr: null,
              stdout: null,
              user_id: "ship_group",
              waiting_for: null,
            },
            {
              attempt: 2,
              duration_ms: 2000,
              exit_code: 0,
              finished_at: "2026-03-17T00:00:03.000Z",
              node_kind: "codex",
              node_path: "/1/0",
              result: "done",
              started_at: "2026-03-17T00:00:01.000Z",
              status: "succeeded",
              stderr: null,
              stdout: null,
              user_id: "ship",
              waiting_for: null,
            },
          ],
          phase: "completed",
          reason: "completed",
          status: "succeeded",
        }),
      },
      {
        expected: {
          error: null,
          lastPath: "/4",
          resultPath: "/4",
          result: { count: 2, ok: true },
          status: "succeeded",
        },
        snapshot: runSnapshot({
          finished_at: "2026-03-17T00:00:04.000Z",
          nodes: [
            {
              attempt: 1,
              duration_ms: 4000,
              exit_code: null,
              finished_at: "2026-03-17T00:00:04.000Z",
              node_kind: "parallel",
              node_path: "/4",
              result: { count: 2, ok: true },
              started_at: "2026-03-17T00:00:00.000Z",
              status: "succeeded",
              stderr: null,
              stdout: null,
              user_id: "fanout",
              waiting_for: null,
            },
          ],
          phase: "completed",
          reason: "completed",
          status: "succeeded",
        }),
      },
      {
        expected: {
          error: null,
          lastPath: "/4/1",
          resultPath: "/4",
          result: { count: 2, ok: true },
          status: "succeeded",
        },
        snapshot: runSnapshot({
          finished_at: "2026-03-17T00:00:04.000Z",
          nodes: [
            {
              attempt: 1,
              duration_ms: 4000,
              exit_code: null,
              finished_at: "2026-03-17T00:00:04.000Z",
              node_kind: "parallel",
              node_path: "/4",
              result: { count: 2, ok: true },
              started_at: "2026-03-17T00:00:00.000Z",
              status: "succeeded",
              stderr: null,
              stdout: null,
              user_id: "fanout",
              waiting_for: null,
            },
            {
              attempt: 1,
              duration_ms: 2000,
              exit_code: 0,
              finished_at: "2026-03-17T00:00:03.000Z",
              node_kind: "shell",
              node_path: "/4/1",
              result: "child",
              started_at: "2026-03-17T00:00:01.000Z",
              status: "succeeded",
              stderr: null,
              stdout: "child\n",
              user_id: "right",
              waiting_for: null,
            },
          ],
          phase: "completed",
          reason: "completed",
          status: "succeeded",
        }),
      },
      {
        expected: {
          error: null,
          lastPath: "/5",
          resultPath: "/5",
          result: 7,
          status: "succeeded",
        },
        snapshot: runSnapshot({
          finished_at: "2026-03-17T00:00:05.000Z",
          nodes: [
            {
              attempt: 1,
              duration_ms: 5000,
              exit_code: 0,
              finished_at: "2026-03-17T00:00:05.000Z",
              node_kind: "shell",
              node_path: "/5",
              result: 7,
              started_at: "2026-03-17T00:00:00.000Z",
              status: "succeeded",
              stderr: null,
              stdout: null,
              user_id: "json",
              waiting_for: null,
            },
          ],
          phase: "completed",
          reason: "completed",
          status: "succeeded",
        }),
      },
      {
        expected: {
          error: "node stderr failure",
          lastPath: "/2",
          resultPath: null,
          result: null,
          status: "failed",
        },
        snapshot: runSnapshot({
          finished_at: "2026-03-17T00:00:03.000Z",
          nodes: [
            {
              attempt: 1,
              duration_ms: 3000,
              exit_code: 1,
              finished_at: "2026-03-17T00:00:03.000Z",
              node_kind: "shell",
              node_path: "/2",
              result: null,
              started_at: "2026-03-17T00:00:00.000Z",
              status: "failed",
              stderr: "node stderr failure",
              stdout: null,
              user_id: "test",
              waiting_for: null,
            },
          ],
          phase: "failed",
          reason: "step_failed",
          status: "failed",
        }),
      },
      {
        expected: {
          error: "Workflow failed because a step timed out.",
          lastPath: "/3",
          resultPath: null,
          result: null,
          status: "failed",
        },
        snapshot: runSnapshot({
          finished_at: "2026-03-17T00:00:05.000Z",
          nodes: [
            {
              attempt: 1,
              duration_ms: 5000,
              exit_code: null,
              finished_at: "2026-03-17T00:00:05.000Z",
              node_kind: "claude",
              node_path: "/3",
              result: null,
              started_at: "2026-03-17T00:00:00.000Z",
              status: "failed",
              stderr: "",
              stdout: null,
              user_id: "review",
              waiting_for: null,
            },
          ],
          phase: "failed",
          reason: "step_timed_out",
          status: "failed",
        }),
      },
    ] as const

    for (const testCase of cases) {
      const summary = resolveWorkflowResult(testCase.snapshot)
      expect(summary.status).toBe(testCase.expected.status)
      expect(summary.result).toEqual(testCase.expected.result)
      expect(summary.error).toBe(testCase.expected.error)
      const resultStep = summary.steps.find((step) => step.path === testCase.expected.resultPath)
      expect(resultStep?.result ?? null).toEqual(testCase.expected.result)
      expect(summary.steps.at(-1)?.id).toBe(testCase.snapshot.nodes.at(-1)?.user_id ?? null)
      expect(summary.steps.at(-1)?.path).toBe(testCase.expected.lastPath)
    }
  })

  test("workflow interrupt controller aborts first and hard-exits on second interrupt", () => {
    const originalKill = process.kill
    let killCount = 0

    ;(process as { kill: typeof process.kill }).kill = ((pid: number, signal?: number | NodeJS.Signals) => {
      expect(pid).toBe(process.pid)
      expect(signal).toBe("SIGINT")
      killCount += 1
      return true
    }) as typeof process.kill

    try {
      const interrupt = createInterrupt()
      interrupt.interrupt()
      expect(interrupt.signal.aborted).toBe(true)

      interrupt.interrupt()
      expect(killCount).toBe(1)
      interrupt.dispose()
    } finally {
      ;(process as { kill: typeof process.kill }).kill = originalKill
    }
  })

  test("builds workflow input questions with type, description, and JSON hints", () => {
    expect(
      buildQuestion("count", {
        description: "How many iterations to run.",
        type: "integer",
      }),
    ).toEqual({
      allowEmpty: true,
      header: "count",
      id: "count",
      initialValue: undefined,
      isOther: false,
      isSecret: false,
      options: null,
      preserveWhitespace: true,
      question:
        "Input: count\nType: integer\nDescription: How many iterations to run.\nEnter JSON for non-string values.",
    })

    expect(
      buildQuestion("name", {
        description: "Display name.",
        type: "string",
      }),
    ).toEqual({
      allowEmpty: true,
      header: "name",
      id: "name",
      initialValue: undefined,
      isOther: false,
      isSecret: false,
      options: null,
      preserveWhitespace: true,
      question: "Input: name\nType: string\nDescription: Display name.",
    })

    expect(
      buildQuestion("config", {
        default: { enabled: true },
        type: "object",
      }),
    ).toEqual({
      allowEmpty: true,
      header: "config",
      id: "config",
      initialValue: '{"enabled":true}',
      isOther: false,
      isSecret: false,
      options: null,
      preserveWhitespace: true,
      question: "Input: config\nType: object\nEnter JSON for non-string values.",
    })
  })

  test("headless verbose text output does not replay streamed final step output", async () => {
    const cwd = await createTempWorkspace()
    await writeWorkflow(
      cwd,
      "plan.yaml",
      ["id: plan", "steps:", "  - type: shell", "    with:", "      command: echo hi"].join("\n"),
    )

    const writes = { stderr: [] as string[], stdout: [] as string[] }

    const result = await runCommand(
      cwd,
      "plan",
      runOptions({ mode: { kind: "headless_text", verbose: true } }),
      stubDeps({
        createInterruptController: stubInterruptController,
        runWorkflowImpl: async (options: RunWorkflowOptions) => {
          options.onEvent?.({
            chunk: "hello\n",
            kind: "step_output",
            node_path: "/0",
            stream: "stdout",
            user_id: "plan",
          })

          return completed(
            runSnapshot({
              finished_at: "2026-03-17T00:00:02.000Z",
              nodes: [
                {
                  attempt: 1,
                  duration_ms: 2000,
                  exit_code: 0,
                  finished_at: "2026-03-17T00:00:02.000Z",
                  node_kind: "shell",
                  node_path: "/0",
                  result: "hello\n",
                  started_at: "2026-03-17T00:00:00.000Z",
                  status: "succeeded",
                  stderr: null,
                  stdout: "hello\n",
                  user_id: "plan",
                  waiting_for: null,
                },
              ],
              phase: "completed",
              reason: "completed",
              status: "succeeded",
              workflow_id: "plan",
            }),
          )
        },
        writeStderr: (text) => {
          writes.stderr.push(text)
        },
        writeStdout: (text) => {
          writes.stdout.push(text)
        },
      }),
    )

    expect(writes.stdout).toEqual(["hello\n"])
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines).toEqual([])
    expect(result.stderrLines).toEqual([])
  })

  test("headless verbose text output still renders a later final result", async () => {
    const cwd = await createTempWorkspace()
    await writeWorkflow(
      cwd,
      "plan.yaml",
      ["id: plan", "steps:", "  - type: shell", "    with:", "      command: echo hi"].join("\n"),
    )

    const writes = { stderr: [] as string[], stdout: [] as string[] }

    const result = await runCommand(
      cwd,
      "plan",
      runOptions({ mode: { kind: "headless_text", verbose: true } }),
      stubDeps({
        createInterruptController: stubInterruptController,
        runWorkflowImpl: async (options: RunWorkflowOptions) => {
          options.onEvent?.({
            chunk: "hello\n",
            kind: "step_output",
            node_path: "/0",
            stream: "stdout",
            user_id: "plan",
          })

          return completed(
            runSnapshot({
              finished_at: "2026-03-17T00:00:02.000Z",
              nodes: [
                {
                  attempt: 1,
                  duration_ms: 1000,
                  exit_code: 0,
                  finished_at: "2026-03-17T00:00:01.000Z",
                  node_kind: "shell",
                  node_path: "/0",
                  result: null,
                  started_at: "2026-03-17T00:00:00.000Z",
                  status: "succeeded",
                  stderr: null,
                  stdout: "hello\n",
                  user_id: "setup",
                  waiting_for: null,
                },
                {
                  attempt: 1,
                  duration_ms: 1000,
                  exit_code: 0,
                  finished_at: "2026-03-17T00:00:02.000Z",
                  node_kind: "shell",
                  node_path: "/1",
                  result: "final",
                  started_at: "2026-03-17T00:00:01.000Z",
                  status: "succeeded",
                  stderr: null,
                  stdout: "",
                  user_id: "result",
                  waiting_for: null,
                },
              ],
              phase: "completed",
              reason: "completed",
              status: "succeeded",
              workflow_id: "plan",
            }),
          )
        },
        writeStderr: (text) => {
          writes.stderr.push(text)
        },
        writeStdout: (text) => {
          writes.stdout.push(text)
        },
      }),
    )

    expect(writes.stdout).toEqual(["hello\n"])
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines).toEqual(["final"])
    expect(result.stderrLines).toEqual([])
  })

  test("headless verbose text output replays the final top-level composite result", async () => {
    const cwd = await createTempWorkspace()
    await writeWorkflow(
      cwd,
      "plan.yaml",
      ["id: plan", "steps:", "  - type: shell", "    with:", "      command: echo hi"].join("\n"),
    )

    const writes = { stderr: [] as string[], stdout: [] as string[] }

    const result = await runCommand(
      cwd,
      "plan",
      runOptions({ mode: { kind: "headless_text", verbose: true } }),
      stubDeps({
        createInterruptController: stubInterruptController,
        runWorkflowImpl: async (options: RunWorkflowOptions) => {
          options.onEvent?.({
            chunk: "child\n",
            kind: "step_output",
            node_path: "/0/1",
            stream: "stdout",
            user_id: "child",
          })

          return completed(
            runSnapshot({
              finished_at: "2026-03-17T00:00:02.000Z",
              nodes: [
                {
                  attempt: 1,
                  duration_ms: 2000,
                  exit_code: null,
                  finished_at: "2026-03-17T00:00:02.000Z",
                  node_kind: "group",
                  node_path: "/0",
                  result: { summary: "final" },
                  started_at: "2026-03-17T00:00:00.000Z",
                  status: "succeeded",
                  stderr: null,
                  stdout: null,
                  user_id: "group",
                  waiting_for: null,
                },
                {
                  attempt: 1,
                  duration_ms: 1000,
                  exit_code: 0,
                  finished_at: "2026-03-17T00:00:01.000Z",
                  node_kind: "shell",
                  node_path: "/0/1",
                  result: "child",
                  started_at: "2026-03-17T00:00:00.000Z",
                  status: "succeeded",
                  stderr: null,
                  stdout: "child\n",
                  user_id: "child",
                  waiting_for: null,
                },
              ],
              phase: "completed",
              reason: "completed",
              status: "succeeded",
              workflow_id: "plan",
            }),
          )
        },
        writeStderr: (text) => {
          writes.stderr.push(text)
        },
        writeStdout: (text) => {
          writes.stdout.push(text)
        },
      }),
    )

    expect(writes.stdout).toEqual(["child\n"])
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines).toEqual(['{"summary":"final"}'])
    expect(result.stderrLines).toEqual([])
  })

  test("headless verbose text output does not replay streamed json result", async () => {
    const cwd = await createTempWorkspace()
    await writeWorkflow(
      cwd,
      "plan.yaml",
      ["id: plan", "steps:", "  - type: shell", "    with:", "      command: echo hi"].join("\n"),
    )

    const writes = { stderr: [] as string[], stdout: [] as string[] }

    const result = await runCommand(
      cwd,
      "plan",
      runOptions({ mode: { kind: "headless_text", verbose: true } }),
      stubDeps({
        createInterruptController: stubInterruptController,
        runWorkflowImpl: async (options: RunWorkflowOptions) => {
          options.onEvent?.({
            chunk: '{\n  "ok": true\n}\n',
            kind: "step_output",
            node_path: "/0",
            stream: "stdout",
            user_id: "plan",
          })

          return completed(
            runSnapshot({
              finished_at: "2026-03-17T00:00:02.000Z",
              nodes: [
                {
                  attempt: 1,
                  duration_ms: 2000,
                  exit_code: 0,
                  finished_at: "2026-03-17T00:00:02.000Z",
                  node_kind: "shell",
                  node_path: "/0",
                  result: { ok: true },
                  started_at: "2026-03-17T00:00:00.000Z",
                  status: "succeeded",
                  stderr: null,
                  stdout: '{\n  "ok": true\n}\n',
                  user_id: "plan",
                  waiting_for: null,
                },
              ],
              phase: "completed",
              reason: "completed",
              status: "succeeded",
              workflow_id: "plan",
            }),
          )
        },
        writeStderr: (text) => {
          writes.stderr.push(text)
        },
        writeStdout: (text) => {
          writes.stdout.push(text)
        },
      }),
    )

    expect(writes.stdout).toEqual(['{\n  "ok": true\n}\n'])
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines).toEqual([])
    expect(result.stderrLines).toEqual([])
  })

  test("headless verbose text output replays the final text result for streamed json strings", async () => {
    const cwd = await createTempWorkspace()
    await writeWorkflow(
      cwd,
      "plan.yaml",
      ["id: plan", "steps:", "  - type: shell", "    with:", "      command: echo hi"].join("\n"),
    )

    const writes = { stderr: [] as string[], stdout: [] as string[] }

    const result = await runCommand(
      cwd,
      "plan",
      runOptions({ mode: { kind: "headless_text", verbose: true } }),
      stubDeps({
        createInterruptController: stubInterruptController,
        runWorkflowImpl: async (options: RunWorkflowOptions) => {
          options.onEvent?.({
            chunk: '"hello"',
            kind: "step_output",
            node_path: "/0",
            stream: "stdout",
            user_id: "plan",
          })

          return completed(
            runSnapshot({
              finished_at: "2026-03-17T00:00:02.000Z",
              nodes: [
                {
                  attempt: 1,
                  duration_ms: 2000,
                  exit_code: 0,
                  finished_at: "2026-03-17T00:00:02.000Z",
                  node_kind: "shell",
                  node_path: "/0",
                  result: "hello",
                  started_at: "2026-03-17T00:00:00.000Z",
                  status: "succeeded",
                  stderr: null,
                  stdout: '"hello"',
                  user_id: "plan",
                  waiting_for: null,
                },
              ],
              phase: "completed",
              reason: "completed",
              status: "succeeded",
              workflow_id: "plan",
            }),
          )
        },
        writeStderr: (text) => {
          writes.stderr.push(text)
        },
        writeStdout: (text) => {
          writes.stdout.push(text)
        },
      }),
    )

    expect(writes.stdout).toEqual(['"hello"'])
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines).toEqual(["hello"])
    expect(result.stderrLines).toEqual([])
  })

  test("headless verbose text failure still emits stderr after streamed output", async () => {
    const cwd = await createTempWorkspace()
    await writeWorkflow(
      cwd,
      "plan.yaml",
      ["id: plan", "steps:", "  - type: shell", "    with:", "      command: echo hi"].join("\n"),
    )

    const result = await runCommand(
      cwd,
      "plan",
      runOptions({ mode: { kind: "headless_text", verbose: true } }),
      stubDeps({
        createInterruptController: stubInterruptController,
        runWorkflowImpl: async (options: RunWorkflowOptions) => {
          options.onEvent?.({
            chunk: "partial\n",
            kind: "step_output",
            node_path: "/0",
            stream: "stdout",
            user_id: "plan",
          })

          return completed(
            runSnapshot({
              finished_at: "2026-03-17T00:00:02.000Z",
              nodes: [
                {
                  attempt: 1,
                  duration_ms: 2000,
                  exit_code: 1,
                  finished_at: "2026-03-17T00:00:02.000Z",
                  node_kind: "shell",
                  node_path: "/0",
                  result: null,
                  started_at: "2026-03-17T00:00:00.000Z",
                  status: "failed",
                  stderr: "step failed",
                  stdout: "partial\n",
                  user_id: "plan",
                  waiting_for: null,
                },
              ],
              phase: "failed",
              reason: "step_failed",
              status: "failed",
              workflow_id: "plan",
            }),
          )
        },
        writeStdout: () => {},
        writeStderr: () => {},
      }),
    )

    expect(result.exitCode).toBe(1)
    expect(result.stdoutLines).toEqual([])
    expect(result.stderrLines).toEqual(["step failed"])
  })

  test("headless verbose text failure does not replay streamed stderr", async () => {
    const cwd = await createTempWorkspace()
    await writeWorkflow(
      cwd,
      "plan.yaml",
      ["id: plan", "steps:", "  - type: shell", "    with:", "      command: echo hi"].join("\n"),
    )

    const writes = { stderr: [] as string[], stdout: [] as string[] }

    const result = await runCommand(
      cwd,
      "plan",
      runOptions({ mode: { kind: "headless_text", verbose: true } }),
      stubDeps({
        createInterruptController: stubInterruptController,
        runWorkflowImpl: async (options: RunWorkflowOptions) => {
          options.onEvent?.({
            chunk: "step failed\n",
            kind: "step_output",
            node_path: "/0",
            stream: "stderr",
            user_id: "plan",
          })

          return completed(
            runSnapshot({
              finished_at: "2026-03-17T00:00:02.000Z",
              nodes: [
                {
                  attempt: 1,
                  duration_ms: 2000,
                  exit_code: 1,
                  finished_at: "2026-03-17T00:00:02.000Z",
                  node_kind: "shell",
                  node_path: "/0",
                  result: null,
                  started_at: "2026-03-17T00:00:00.000Z",
                  status: "failed",
                  stderr: "step failed\n",
                  stdout: null,
                  user_id: "plan",
                  waiting_for: null,
                },
              ],
              phase: "failed",
              reason: "step_failed",
              status: "failed",
              workflow_id: "plan",
            }),
          )
        },
        writeStderr: (text) => {
          writes.stderr.push(text)
        },
        writeStdout: (text) => {
          writes.stdout.push(text)
        },
      }),
    )

    expect(writes.stderr).toEqual(["step failed\n"])
    expect(result.exitCode).toBe(1)
    expect(result.stdoutLines).toEqual([])
    expect(result.stderrLines).toEqual([])
  })

  test("headless json replays the final failed snapshot when runWorkflow throws after run_finished", async () => {
    const cwd = await createTempWorkspace()
    await writeWorkflow(
      cwd,
      "plan.yaml",
      ["id: plan", "steps:", "  - type: shell", "    with:", "      command: echo hi"].join("\n"),
    )

    const writes = { stderr: [] as string[], stdout: [] as string[] }

    const result = await runCommand(
      cwd,
      "plan",
      runOptions({ mode: { kind: "headless_json" } }),
      stubDeps({
        createInterruptController: stubInterruptController,
        runWorkflowImpl: async (options: RunWorkflowOptions) => {
          options.onEvent?.({
            kind: "run_finished",
            snapshot: runSnapshot({
              finished_at: "2026-03-17T00:00:02.000Z",
              nodes: [
                {
                  attempt: 1,
                  duration_ms: 2000,
                  exit_code: 1,
                  finished_at: "2026-03-17T00:00:02.000Z",
                  node_kind: "shell",
                  node_path: "/0",
                  result: null,
                  started_at: "2026-03-17T00:00:00.000Z",
                  status: "failed",
                  stderr: "evaluation failed",
                  stdout: null,
                  user_id: "plan",
                  waiting_for: null,
                },
              ],
              phase: "failed",
              reason: "evaluation_error",
              started_at: "2026-03-17T00:00:00.000Z",
              status: "failed",
              workflow_id: "plan",
            }),
          })

          throw new Error("evaluation failed")
        },
        writeStderr: (text) => {
          writes.stderr.push(text)
        },
        writeStdout: (text) => {
          writes.stdout.push(text)
        },
      }),
    )

    expect(result.exitCode).toBe(1)
    expect(result.stderrLines).toEqual([])
    expect(result.stdoutLines).toEqual([])
    expect(writes.stderr).toEqual([])
    expect(writes.stdout).toHaveLength(1)
    expect(JSON.parse(writes.stdout[0] ?? "{}")).toEqual({
      durationMs: 2000,
      error: "evaluation failed",
      finishedAt: "2026-03-17T00:00:02.000Z",
      phase: "failed",
      reason: "evaluation_error",
      result: null,
      runId: "run-123",
      startedAt: "2026-03-17T00:00:00.000Z",
      status: "failed",
      steps: [
        {
          attempt: 1,
          durationMs: 2000,
          exitCode: 1,
          finishedAt: "2026-03-17T00:00:02.000Z",
          id: "plan",
          kind: "shell",
          path: "/0",
          result: null,
          startedAt: "2026-03-17T00:00:00.000Z",
          status: "failed",
          waitingFor: null,
        },
      ],
      workflowId: "plan",
    })
  })

  test("prompts for omitted inputs and prefills defaults before runWorkflow", async () => {
    const cwd = await createTempWorkspace()
    await writeWorkflow(
      cwd,
      "prompt.yaml",
      [
        "id: prompt",
        "inputs:",
        "  name:",
        "    type: string",
        "  count:",
        "    type: integer",
        "    description: Number of retries.",
        "  output_path:",
        "    type: string",
        "    default: plan.md",
        "steps:",
        "  - type: shell",
        "    with:",
        "      command: echo hi",
      ].join("\n"),
    )

    await withTTYState({ stderr: true, stdin: true }, async () => {
      const handledRequests: RunControlRequest[] = []
      const runWorkflowCalls: Array<Record<string, unknown>> = []

      const result = await runCommand(
        cwd,
        "prompt",
        runOptions({ inputs: ["name=cli-name"] }),
        stubDeps({
          createInterruptController: stubInterruptController,
          createRunSession: () =>
            stubRunSession({
              handle: async (request: RunControlRequest) => {
                handledRequests.push(request)
                return {
                  answers: {
                    count: { answers: ["42"] },
                    output_path: { answers: ["custom.md"] },
                  },
                  kind: "user_input",
                }
              },
            }),
          now: () => "2026-03-17T00:00:00.000Z",
          runWorkflowImpl: async (options: RunWorkflowOptions) => {
            runWorkflowCalls.push(options.invocationInputs)
            return completed(
              runSnapshot({
                finished_at: "2026-03-17T00:00:02.000Z",
                phase: "completed",
                reason: "completed",
                status: "succeeded",
                workflow_id: "prompt",
              }),
            )
          },
        }),
      )

      expect(result.exitCode).toBe(0)
      expect(handledRequests).toHaveLength(1)
      const request = handledRequests[0]
      expect(request?.kind).toBe("interaction")
      if (request === undefined || request.kind !== "interaction") {
        throw new Error("expected interaction request")
      }
      expect(request.interaction.request.kind).toBe("user_input")
      if (request.interaction.request.kind !== "user_input") {
        throw new Error("expected user_input request")
      }
      expect(request.interaction.request.questions).toEqual([
        {
          allowEmpty: true,
          header: "count",
          id: "count",
          initialValue: undefined,
          isOther: false,
          isSecret: false,
          options: null,
          preserveWhitespace: true,
          question: "Input: count\nType: integer\nDescription: Number of retries.\nEnter JSON for non-string values.",
        },
        {
          allowEmpty: true,
          header: "output_path",
          id: "output_path",
          initialValue: "plan.md",
          isOther: false,
          isSecret: false,
          options: null,
          preserveWhitespace: true,
          question: "Input: output_path\nType: string",
        },
      ])
      expect(runWorkflowCalls).toEqual([
        {
          count: "42",
          name: "cli-name",
          output_path: "custom.md",
        },
      ])
    })
  })

  test("skips the prompt when all required inputs are already provided", async () => {
    const cwd = await createTempWorkspace()
    await writeWorkflow(
      cwd,
      "prompt.yaml",
      [
        "id: prompt",
        "inputs:",
        "  name:",
        "    type: string",
        "  config:",
        "    type: object",
        "    properties:",
        "      enabled:",
        "        type: boolean",
        "    required: [enabled]",
        "steps:",
        "  - type: shell",
        "    with:",
        "      command: echo hi",
      ].join("\n"),
    )

    await withTTYState({ stderr: true, stdin: true }, async () => {
      let handleCount = 0
      const runWorkflowCalls: Array<Record<string, unknown>> = []

      const result = await runCommand(
        cwd,
        "prompt",
        runOptions({ inputs: ["name=cli-name", 'config={\"enabled\":true}'] }),
        stubDeps({
          createInterruptController: stubInterruptController,
          createRunSession: () =>
            stubRunSession({
              handle: async () => {
                handleCount += 1
                return { answers: {}, kind: "user_input" }
              },
            }),
          runWorkflowImpl: async (options: RunWorkflowOptions) => {
            runWorkflowCalls.push(options.invocationInputs)
            return completed(
              runSnapshot({
                finished_at: "2026-03-17T00:00:02.000Z",
                phase: "completed",
                reason: "completed",
                status: "succeeded",
                workflow_id: "prompt",
              }),
            )
          },
        }),
      )

      expect(result.exitCode).toBe(0)
      expect(handleCount).toBe(0)
      expect(runWorkflowCalls).toEqual([
        {
          config: '{"enabled":true}',
          name: "cli-name",
        },
      ])
    })
  })

  test("passes raw prompted answers to workflow execution for schema-aware normalization", async () => {
    const cwd = await createTempWorkspace()
    await writeWorkflow(
      cwd,
      "prompt.yaml",
      [
        "id: prompt",
        "inputs:",
        "  enabled:",
        "    type: boolean",
        "  tags:",
        "    type: array",
        "    items:",
        "      type: string",
        "  note:",
        "    type: string",
        "steps:",
        "  - type: shell",
        "    with:",
        "      command: echo hi",
      ].join("\n"),
    )

    await withTTYState({ stderr: true, stdin: true }, async () => {
      const runWorkflowCalls: Array<Record<string, unknown>> = []

      const result = await runCommand(
        cwd,
        "prompt",
        runOptions(),
        stubDeps({
          createInterruptController: stubInterruptController,
          createRunSession: () =>
            stubRunSession({
              handle: async () => ({
                answers: {
                  enabled: { answers: ["true"] },
                  note: { answers: ["not-json"] },
                  tags: { answers: ['["a","b"]'] },
                },
                kind: "user_input",
              }),
            }),
          runWorkflowImpl: async (options: RunWorkflowOptions) => {
            runWorkflowCalls.push(options.invocationInputs)
            return completed(
              runSnapshot({
                finished_at: "2026-03-17T00:00:02.000Z",
                phase: "completed",
                reason: "completed",
                status: "succeeded",
                workflow_id: "prompt",
              }),
            )
          },
        }),
      )

      expect(result.exitCode).toBe(0)
      expect(runWorkflowCalls).toEqual([
        {
          enabled: "true",
          note: "not-json",
          tags: '["a","b"]',
        },
      ])
    })
  })

  test("invalid prompted values surface through the existing invalid_input path", async () => {
    const cwd = await createTempWorkspace()
    await writeWorkflow(
      cwd,
      "prompt.yaml",
      [
        "id: prompt",
        "inputs:",
        "  count:",
        "    type: integer",
        "steps:",
        "  - type: shell",
        "    with:",
        "      command: echo hi",
      ].join("\n"),
    )

    await withTTYState({ stderr: true, stdin: true }, async () => {
      const result = await runCommand(
        cwd,
        "prompt",
        runOptions(),
        stubDeps({
          createInterruptController: stubInterruptController,
          createRunSession: () =>
            stubRunSession({
              handle: async () => ({
                answers: { count: { answers: ["abc"] } },
                kind: "user_input",
              }),
            }),
          runWorkflowImpl: async (options: RunWorkflowOptions) => {
            const project = workflowProject([
              {
                filePath: join(cwd, ".rigg", "prompt.yaml"),
                relativePath: "prompt.yaml",
                workflow: {
                  id: "prompt",
                  inputs: {
                    count: { type: "integer" },
                  },
                  steps: [{ type: "shell", with: { command: "echo hi" } }],
                },
              },
            ])
            const { runWorkflow } = await import("../../src/session")
            return await runWorkflow({
              controlHandler: async () => {
                throw new Error("unexpected control request")
              },
              invocationInputs: options.invocationInputs,
              parentEnv: process.env,
              project,
              workflowId: "prompt",
            })
          },
        }),
      )

      expect(result.exitCode).toBe(1)
      expect(result.stderrLines).toEqual(["inputs.count must be an integer"])
    })
  })

  test("interrupting the pre-run prompt returns the standard interrupt message", async () => {
    const cwd = await createTempWorkspace()
    await writeWorkflow(
      cwd,
      "prompt.yaml",
      [
        "id: prompt",
        "inputs:",
        "  name:",
        "    type: string",
        "steps:",
        "  - type: shell",
        "    with:",
        "      command: echo hi",
      ].join("\n"),
    )

    await withTTYState({ stderr: true, stdin: true }, async () => {
      const controller = new AbortController()

      const result = await runCommand(
        cwd,
        "prompt",
        runOptions(),
        stubDeps({
          createInterruptController: () => ({
            dispose: () => {},
            interrupt: () => controller.abort(interrupt("workflow interrupted by operator")),
            signal: controller.signal,
          }),
          createRunSession: () =>
            stubRunSession({
              handle: async (request: RunControlRequest) => {
                queueMicrotask(() => controller.abort(interrupt("workflow interrupted by operator")))
                return await new Promise((_, reject) => {
                  request.signal.addEventListener(
                    "abort",
                    () => reject(new DOMException("workflow interrupted by operator", "AbortError")),
                    { once: true },
                  )
                })
              },
            }),
        }),
      )

      expect(result.exitCode).toBe(1)
      expect(result.stderrLines).toEqual(["workflow interrupted by operator"])
    })
  })
})
