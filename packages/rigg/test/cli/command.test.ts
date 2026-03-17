import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  buildOmittedInputQuestion,
  createWorkflowInterruptController,
  runInitCommand,
  runRunCommand,
  runValidateCommand,
} from "../../src/cli/command"
import { examplesDoc, schemaReferenceDoc, skillDoc, workflowSyntaxDoc } from "../../src/cli/docs"
import { StepInterruptedError } from "../../src/run/error"
import { runSnapshot, workflowProject } from "../fixture/builders"
import {
  planTemplate,
  reviewBranchTemplate,
  reviewCommitTemplate,
  reviewUncommittedTemplate,
} from "../../src/cli/templates"

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

describe("cli/command", () => {
  test("init generates workflow, docs, and skill assets from packages/rigg", async () => {
    const cwd = await createTempWorkspace()

    const initResult = await runInitCommand(cwd)
    expect(initResult.exitCode).toBe(0)

    const validateResult = await runValidateCommand(cwd)
    expect(validateResult.exitCode).toBe(0)
    expect(validateResult.stdoutLines.join("\n")).toContain("plan")
    expect(validateResult.stdoutLines.join("\n")).toContain("review-uncommitted")
    expect(validateResult.stdoutLines.join("\n")).toContain("review-branch")
    expect(validateResult.stdoutLines.join("\n")).toContain("review-commit")

    expect(await readFile(join(cwd, ".rigg", "plan.yaml"), "utf8")).toBe(planTemplate)
    expect(await readFile(join(cwd, ".rigg", "review-uncommitted.yaml"), "utf8")).toBe(reviewUncommittedTemplate)
    expect(await readFile(join(cwd, ".rigg", "review-branch.yaml"), "utf8")).toBe(reviewBranchTemplate)
    expect(await readFile(join(cwd, ".rigg", "review-commit.yaml"), "utf8")).toBe(reviewCommitTemplate)

    expect(await readFile(join(cwd, ".rigg", "docs", "workflow-syntax.md"), "utf8")).toBe(workflowSyntaxDoc)
    expect(await readFile(join(cwd, ".rigg", "docs", "schema-reference.md"), "utf8")).toBe(schemaReferenceDoc)
    expect(await readFile(join(cwd, ".rigg", "docs", "examples.md"), "utf8")).toBe(examplesDoc)

    expect(await readFile(join(cwd, ".agents", "skills", "rigg", "SKILL.md"), "utf8")).toBe(skillDoc)

    await runInitCommand(cwd)
    expect(await Bun.file(join(cwd, ".gitignore")).exists()).toBe(false)
  })

  test("run requires interactive stdin and stderr", async () => {
    const cwd = await createTempWorkspace()
    await runInitCommand(cwd)

    await withTTYState({ stderr: true, stdin: false }, async () => {
      const result = await runRunCommand(cwd, "plan", { inputs: [] })
      expect(result.exitCode).toBe(1)
      expect(result.stderrLines.join("\n")).toContain("interactive terminal")
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
      const interrupt = createWorkflowInterruptController()
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
      buildOmittedInputQuestion("count", {
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
      buildOmittedInputQuestion("name", {
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
      buildOmittedInputQuestion("config", {
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

      const result = await runRunCommand(
        cwd,
        "prompt",
        { inputs: ["name=cli-name"] },
        {
          createInterruptController: () => {
            const controller = new AbortController()
            return {
              dispose: () => {},
              interrupt: () => controller.abort(new StepInterruptedError("workflow interrupted by operator")),
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

      const result = await runRunCommand(
        cwd,
        "prompt",
        { inputs: ["name=cli-name", 'config={\"enabled\":true}'] },
        {
          createInterruptController: () => {
            const controller = new AbortController()
            return {
              dispose: () => {},
              interrupt: () => controller.abort(new StepInterruptedError("workflow interrupted by operator")),
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

      const result = await runRunCommand(
        cwd,
        "prompt",
        { inputs: [] },
        {
          createInterruptController: () => {
            const controller = new AbortController()
            return {
              dispose: () => {},
              interrupt: () => controller.abort(new StepInterruptedError("workflow interrupted by operator")),
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
      const result = await runRunCommand(
        cwd,
        "prompt",
        { inputs: [] },
        {
          createInterruptController: () => {
            const controller = new AbortController()
            return {
              dispose: () => {},
              interrupt: () => controller.abort(new StepInterruptedError("workflow interrupted by operator")),
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
            const { runWorkflow } = await import("../../src/run/index")
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

      const result = await runRunCommand(
        cwd,
        "prompt",
        { inputs: [] },
        {
          createInterruptController: () => ({
            dispose: () => {},
            interrupt: () => controller.abort(new StepInterruptedError("workflow interrupted by operator")),
            signal: controller.signal,
          }),
          createRunSession: (() => ({
            close: () => {},
            emit: () => {},
            handle: async (request: any) => {
              queueMicrotask(() => controller.abort(new StepInterruptedError("workflow interrupted by operator")))
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
