import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildQuestion, createInterrupt, runCommand } from "../../src/cli/run"
import { interrupt } from "../../src/session/error"
import { runSnapshot, workflowProject } from "../fixture/builders"

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
      const result = await runCommand(cwd, "plan", { autoContinue: false, inputs: [] })
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
      const result = await runCommand(cwd, "plan", { autoContinue: true, inputs: [] })
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
        { autoContinue: true, inputs: [] },
        {
          createInterruptController: () => {
            const controller = new AbortController()
            return {
              dispose: () => {},
              interrupt: () => controller.abort(interrupt("workflow interrupted by operator")),
              signal: controller.signal,
            }
          },
          createRunSession: ((options: any) => {
            createRunSessionCalls.push(options.barrierMode)
            return {
              close: () => {},
              emit: () => {},
              handle: async () => {
                throw new Error("unexpected control request")
              },
            }
          }) as any,
          runWorkflowImpl: (async () => ({
            kind: "completed",
            snapshot: runSnapshot({
              finished_at: "2026-03-17T00:00:02.000Z",
              phase: "completed",
              reason: "completed",
              status: "succeeded",
              workflow_id: "prompt",
            }),
          })) as any,
        },
      )

      expect(result.exitCode).toBe(0)
      expect(createRunSessionCalls).toEqual(["auto_continue"])
    })
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
      const handledRequests: any[] = []
      const runWorkflowCalls: Array<Record<string, unknown>> = []

      const result = await runCommand(
        cwd,
        "prompt",
        { autoContinue: false, inputs: ["name=cli-name"] },
        {
          createInterruptController: () => {
            const controller = new AbortController()
            return {
              dispose: () => {},
              interrupt: () => controller.abort(interrupt("workflow interrupted by operator")),
              signal: controller.signal,
            }
          },
          createRunSession: (() => ({
            close: () => {},
            emit: () => {},
            handle: async (request: any) => {
              handledRequests.push(request)
              return {
                answers: {
                  count: { answers: ["42"] },
                  output_path: { answers: ["custom.md"] },
                },
                kind: "user_input",
              }
            },
          })) as any,
          now: () => "2026-03-17T00:00:00.000Z",
          runWorkflowImpl: (async (options: any) => {
            runWorkflowCalls.push(options.invocationInputs)
            return {
              kind: "completed",
              snapshot: runSnapshot({
                finished_at: "2026-03-17T00:00:02.000Z",
                phase: "completed",
                reason: "completed",
                status: "succeeded",
                workflow_id: "prompt",
              }),
            }
          }) as any,
        },
      )

      expect(result.exitCode).toBe(0)
      expect(handledRequests).toHaveLength(1)
      expect(handledRequests[0]?.interaction.request.questions).toEqual([
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
        { autoContinue: false, inputs: ["name=cli-name", 'config={\"enabled\":true}'] },
        {
          createInterruptController: () => {
            const controller = new AbortController()
            return {
              dispose: () => {},
              interrupt: () => controller.abort(interrupt("workflow interrupted by operator")),
              signal: controller.signal,
            }
          },
          createRunSession: (() => ({
            close: () => {},
            emit: () => {},
            handle: async () => {
              handleCount += 1
              return { answers: {}, kind: "user_input" }
            },
          })) as any,
          runWorkflowImpl: (async (options: any) => {
            runWorkflowCalls.push(options.invocationInputs)
            return {
              kind: "completed",
              snapshot: runSnapshot({
                finished_at: "2026-03-17T00:00:02.000Z",
                phase: "completed",
                reason: "completed",
                status: "succeeded",
                workflow_id: "prompt",
              }),
            }
          }) as any,
        },
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
        { autoContinue: false, inputs: [] },
        {
          createInterruptController: () => {
            const controller = new AbortController()
            return {
              dispose: () => {},
              interrupt: () => controller.abort(interrupt("workflow interrupted by operator")),
              signal: controller.signal,
            }
          },
          createRunSession: (() => ({
            close: () => {},
            emit: () => {},
            handle: async () => ({
              answers: {
                enabled: { answers: ["true"] },
                note: { answers: ["not-json"] },
                tags: { answers: ['["a","b"]'] },
              },
              kind: "user_input",
            }),
          })) as any,
          runWorkflowImpl: (async (options: any) => {
            runWorkflowCalls.push(options.invocationInputs)
            return {
              kind: "completed",
              snapshot: runSnapshot({
                finished_at: "2026-03-17T00:00:02.000Z",
                phase: "completed",
                reason: "completed",
                status: "succeeded",
                workflow_id: "prompt",
              }),
            }
          }) as any,
        },
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
        { autoContinue: false, inputs: [] },
        {
          createInterruptController: () => {
            const controller = new AbortController()
            return {
              dispose: () => {},
              interrupt: () => controller.abort(interrupt("workflow interrupted by operator")),
              signal: controller.signal,
            }
          },
          createRunSession: (() => ({
            close: () => {},
            emit: () => {},
            handle: async () => ({
              answers: { count: { answers: ["abc"] } },
              kind: "user_input",
            }),
          })) as any,
          runWorkflowImpl: (async (options: any) => {
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
          }) as any,
        },
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
        { autoContinue: false, inputs: [] },
        {
          createInterruptController: () => ({
            dispose: () => {},
            interrupt: () => controller.abort(interrupt("workflow interrupted by operator")),
            signal: controller.signal,
          }),
          createRunSession: (() => ({
            close: () => {},
            emit: () => {},
            handle: async (request: any) => {
              queueMicrotask(() => controller.abort(interrupt("workflow interrupted by operator")))
              return await new Promise((_, reject) => {
                request.signal.addEventListener(
                  "abort",
                  () => reject(new DOMException("workflow interrupted by operator", "AbortError")),
                  { once: true },
                )
              })
            },
          })) as any,
        },
      )

      expect(result.exitCode).toBe(1)
      expect(result.stderrLines).toEqual(["workflow interrupted by operator"])
    })
  })
})
