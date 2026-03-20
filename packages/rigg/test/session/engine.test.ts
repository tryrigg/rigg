import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import type { WorkflowDocument } from "../../src/workflow/schema"
import { createNonInteractiveRunSession } from "../../src/cli/session"
import { interrupt } from "../../src/session/error"
import type { RunEvent } from "../../src/session/event"
import { executeWorkflow } from "../../src/session/engine"
import { installFakeCodex } from "../fixture/fake-codex"
import { workflowProject } from "../fixture/builders"

const defaultRunControl = createNonInteractiveRunSession()

type ExecuteWorkflowInput = Parameters<typeof executeWorkflow>[0]

function runWorkflow(
  options: Omit<ExecuteWorkflowInput, "controlHandler"> & { controlHandler?: ExecuteWorkflowInput["controlHandler"] },
) {
  const { controlHandler = defaultRunControl.handle, ...rest } = options
  return executeWorkflow({
    controlHandler,
    ...rest,
  })
}

describe("session/engine", () => {
  test("uses project root as the execution cwd and write_file base path", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-"))

    try {
      const workflow: WorkflowDocument = {
        id: "cwd-parity",
        steps: [
          {
            id: "pwd",
            type: "shell",
            with: {
              command: "pwd",
              result: "text",
            },
          },
          {
            id: "write",
            type: "write_file",
            with: {
              content: "from project root",
              path: "artifacts/output.txt",
            },
          },
        ],
      }

      const snapshot = await runWorkflow({
        invocationInputs: {},
        parentEnv: process.env,
        projectRoot: root,
        workflow,
      })

      expect(snapshot.nodes.find((node) => node.user_id === "pwd")?.stdout).toBe(`${root}\n`)
      expect(snapshot.nodes.find((node) => node.user_id === "write")?.result).toEqual({
        path: join(root, "artifacts/output.txt"),
      })
      expect(await readFile(join(root, "artifacts/output.txt"), "utf8")).toBe("from project root")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("stores null as the logical result for failed action nodes", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-failed-action-"))

    try {
      const snapshot = await runWorkflow({
        invocationInputs: {},
        parentEnv: process.env,
        projectRoot: root,
        workflow: {
          id: "failed-action-result",
          steps: [
            {
              id: "fail",
              type: "shell",
              with: {
                command: "printf 'partial output'; exit 9",
                result: "text",
              },
            },
          ],
        },
      })

      expect(snapshot.status).toBe("failed")
      expect(snapshot.nodes.find((node) => node.user_id === "fail")).toMatchObject({
        exit_code: 9,
        result: null,
        status: "failed",
        stdout: "partial output",
      })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("does not expose exports as result when a control node fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-failed-control-"))

    async function run(workflow: WorkflowDocument) {
      return runWorkflow({
        invocationInputs: {},
        parentEnv: process.env,
        projectRoot: root,
        workflow,
      })
    }

    try {
      const groupSnapshot = await run({
        id: "failed-group-result",
        steps: [
          {
            exports: {
              copied: "${{ steps.fail.result }}",
            },
            id: "group",
            steps: [
              {
                id: "fail",
                type: "shell",
                with: {
                  command: "printf 'group'; exit 3",
                  result: "text",
                },
              },
            ],
            type: "group",
          },
        ],
      })
      const branchSnapshot = await run({
        id: "failed-branch-result",
        steps: [
          {
            cases: [
              {
                exports: {
                  copied: "${{ steps.fail.result }}",
                },
                if: "${{ true }}",
                steps: [
                  {
                    id: "fail",
                    type: "shell",
                    with: {
                      command: "printf 'branch'; exit 4",
                      result: "text",
                    },
                  },
                ],
              },
              {
                else: true,
                exports: {
                  copied: "${{ 'ok' }}",
                },
                steps: [],
              },
            ],
            id: "branch",
            type: "branch",
          },
        ],
      })
      const parallelSnapshot = await run({
        id: "failed-parallel-result",
        steps: [
          {
            branches: [
              {
                id: "left",
                steps: [
                  {
                    id: "fail",
                    type: "shell",
                    with: {
                      command: "printf 'parallel'; exit 5",
                      result: "text",
                    },
                  },
                ],
              },
              {
                id: "right",
                steps: [],
              },
            ],
            exports: {
              copied: "${{ steps.fail.result }}",
            },
            id: "parallel",
            type: "parallel",
          },
        ],
      })

      expect(groupSnapshot.nodes.find((node) => node.user_id === "group")?.result).toBeNull()
      expect(branchSnapshot.nodes.find((node) => node.user_id === "branch")?.result).toBeNull()
      expect(parallelSnapshot.nodes.find((node) => node.user_id === "parallel")?.result).toBeNull()
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("executes nested workflows inside the same run snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-workflow-step-"))
    const childContexts: Array<{ env: Record<string, string | undefined>; inputs: Record<string, unknown> }> = []

    try {
      const project = workflowProject([
        {
          workflow: {
            env: {
              CHILD_NAME: "${{ inputs.name }}",
            },
            id: "child",
            inputs: {
              count: { type: "integer" },
              enabled: { type: "boolean" },
              name: { type: "string" },
            },
            steps: [
              {
                id: "inner",
                type: "shell",
                with: {
                  command: "echo inner",
                  result: "text",
                },
              },
            ],
          },
        },
        {
          workflow: {
            id: "parent",
            inputs: {
              name: { type: "string" },
            },
            steps: [
              {
                id: "call_child",
                type: "workflow",
                with: {
                  inputs: {
                    count: 3,
                    enabled: true,
                    name: "${{ inputs.name }}",
                  },
                  workflow: "child",
                },
              },
            ],
          },
        },
      ])

      const parentWorkflow = project.files.find((file) => file.workflow.id === "parent")?.workflow
      expect(parentWorkflow).toBeDefined()

      const snapshot = await runWorkflow({
        internals: {
          runActionStep: async (step, context) => {
            if (step.id === "inner") {
              childContexts.push({ env: context.env, inputs: context.inputs })
            }

            return {
              exitCode: 0,
              providerEvents: [],
              result: step.id ?? "ok",
              stderr: "",
              stdout: "ok",
              termination: "completed",
            }
          },
        },
        invocationInputs: {
          name: "Rigg",
        },
        parentEnv: {
          ...process.env,
          SHARED_ENV: "shared",
        },
        project,
        projectRoot: root,
        workflow: parentWorkflow!,
      })

      expect(childContexts).toEqual([
        {
          env: expect.objectContaining({
            CHILD_NAME: "Rigg",
            SHARED_ENV: "shared",
          }),
          inputs: {
            count: 3,
            enabled: true,
            name: "Rigg",
          },
        },
      ])
      expect(snapshot.nodes.find((node) => node.user_id === "call_child")).toMatchObject({
        node_kind: "workflow",
        node_path: "/0",
        result: null,
        status: "succeeded",
      })
      expect(snapshot.nodes.find((node) => node.user_id === "inner")).toMatchObject({
        node_kind: "shell",
        node_path: "/0/0",
        result: "inner",
        status: "succeeded",
      })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("does not re-request the first barrier inside nested workflow calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-workflow-barrier-"))
    const barriers: string[][] = []

    try {
      const project = workflowProject([
        {
          workflow: {
            id: "child",
            steps: [
              {
                id: "child_first",
                type: "shell",
                with: {
                  command: "child-first",
                  result: "text",
                },
              },
              {
                id: "child_second",
                type: "shell",
                with: {
                  command: "child-second",
                  result: "text",
                },
              },
            ],
          },
        },
        {
          workflow: {
            id: "parent",
            steps: [
              {
                id: "call_child",
                type: "workflow",
                with: {
                  workflow: "child",
                },
              },
            ],
          },
        },
      ])

      const workflow = project.files.find((file) => file.workflow.id === "parent")?.workflow
      expect(workflow).toBeDefined()

      await runWorkflow({
        controlHandler: async (request) => {
          if (request.kind === "step_barrier") {
            barriers.push(request.barrier.next.map((step) => step.user_id ?? step.node_path))
            return { action: "continue", kind: "step_barrier" }
          }
          throw new Error(`unexpected control request ${request.kind}`)
        },
        internals: {
          runActionStep: async () => ({
            exitCode: 0,
            providerEvents: [],
            result: "ok",
            stderr: "",
            stdout: "ok",
            termination: "completed",
          }),
        },
        invocationInputs: {},
        parentEnv: process.env,
        project,
        projectRoot: root,
        workflow: workflow!,
      })

      expect(barriers).toEqual([["child_first"], ["child_second"]])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("recursively marks nested workflow descendants as skipped", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-workflow-skip-"))

    try {
      const project = workflowProject([
        {
          workflow: {
            id: "child",
            steps: [
              {
                id: "inner",
                type: "shell",
                with: {
                  command: "echo inner",
                },
              },
            ],
          },
        },
        {
          workflow: {
            id: "parent",
            steps: [
              {
                id: "call_child",
                if: "${{ false }}",
                type: "workflow",
                with: {
                  workflow: "child",
                },
              },
            ],
          },
        },
      ])

      const parentWorkflow = project.files.find((file) => file.workflow.id === "parent")?.workflow
      expect(parentWorkflow).toBeDefined()

      const snapshot = await runWorkflow({
        invocationInputs: {},
        parentEnv: process.env,
        project,
        projectRoot: root,
        workflow: parentWorkflow!,
      })

      expect(snapshot.nodes.find((node) => node.user_id === "call_child")).toMatchObject({
        node_kind: "workflow",
        node_path: "/0",
        status: "skipped",
      })
      expect(snapshot.nodes.find((node) => node.user_id === "inner")).toMatchObject({
        node_kind: "shell",
        node_path: "/0/0",
        status: "skipped",
      })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("rejects circular workflow references while expanding skipped descendants", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-workflow-skip-cycle-"))

    try {
      const project = workflowProject([
        {
          workflow: {
            id: "a",
            steps: [
              {
                id: "call_b",
                if: "${{ false }}",
                type: "workflow",
                with: {
                  workflow: "b",
                },
              },
            ],
          },
        },
        {
          workflow: {
            id: "b",
            steps: [
              {
                id: "call_a",
                type: "workflow",
                with: {
                  workflow: "a",
                },
              },
            ],
          },
        },
      ])

      const workflow = project.files.find((file) => file.workflow.id === "a")?.workflow
      expect(workflow).toBeDefined()

      await expect(
        runWorkflow({
          invocationInputs: {},
          parentEnv: process.env,
          project,
          projectRoot: root,
          workflow: workflow!,
        }),
      ).rejects.toThrow("Step `call_b` creates a circular workflow reference: b -> a -> b.")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("rejects circular workflow references before frontier planning recurses indefinitely", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-workflow-frontier-cycle-"))

    try {
      const project = workflowProject([
        {
          workflow: {
            id: "a",
            steps: [
              {
                id: "call_b",
                type: "workflow",
                with: {
                  workflow: "b",
                },
              },
            ],
          },
        },
        {
          workflow: {
            id: "b",
            steps: [
              {
                id: "call_a",
                type: "workflow",
                with: {
                  workflow: "a",
                },
              },
            ],
          },
        },
      ])

      const workflow = project.files.find((file) => file.workflow.id === "a")?.workflow
      expect(workflow).toBeDefined()

      await expect(
        runWorkflow({
          controlHandler: async (request) => {
            if (request.kind === "step_barrier") {
              return { action: "continue", kind: "step_barrier" }
            }
            throw new Error(`unexpected control request ${request.kind}`)
          },
          invocationInputs: {},
          parentEnv: process.env,
          project,
          projectRoot: root,
          workflow: workflow!,
        }),
      ).rejects.toThrow("Step `call_a` creates a circular workflow reference: a -> b -> a.")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("rejects invalid nested workflow invocation inputs at runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-workflow-invalid-input-"))

    try {
      const project = workflowProject([
        {
          workflow: {
            id: "child",
            inputs: {
              enabled: { type: "boolean" },
            },
            steps: [
              {
                id: "inner",
                type: "shell",
                with: {
                  command: "echo inner",
                },
              },
            ],
          },
        },
        {
          workflow: {
            id: "parent",
            steps: [
              {
                id: "call_child",
                type: "workflow",
                with: {
                  inputs: {
                    enabled: "nope",
                  },
                  workflow: "child",
                },
              },
            ],
          },
        },
      ])

      const parentWorkflow = project.files.find((file) => file.workflow.id === "parent")?.workflow
      expect(parentWorkflow).toBeDefined()

      await expect(
        runWorkflow({
          invocationInputs: {},
          parentEnv: process.env,
          project,
          projectRoot: root,
          workflow: parentWorkflow!,
        }),
      ).rejects.toThrow("inputs.enabled must be a boolean")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("rejects invalid workflow-call inputs before parallel siblings start", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-parallel-invalid-workflow-input-"))
    const startedSteps: string[] = []

    try {
      const project = workflowProject([
        {
          workflow: {
            id: "child",
            inputs: {
              enabled: { type: "boolean" },
            },
            steps: [
              {
                id: "child_leaf",
                type: "shell",
                with: {
                  command: "echo child",
                },
              },
            ],
          },
        },
        {
          workflow: {
            id: "parent",
            steps: [
              {
                id: "fanout",
                type: "parallel",
                branches: [
                  {
                    id: "invalid",
                    steps: [
                      {
                        id: "call_child",
                        type: "workflow",
                        with: {
                          inputs: {
                            enabled: "nope",
                          },
                          workflow: "child",
                        },
                      },
                    ],
                  },
                  {
                    id: "sibling",
                    steps: [
                      {
                        id: "side_effect",
                        type: "shell",
                        with: {
                          command: "echo sibling",
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ])

      const parentWorkflow = project.files.find((file) => file.workflow.id === "parent")?.workflow
      expect(parentWorkflow).toBeDefined()

      await expect(
        runWorkflow({
          internals: {
            runActionStep: async (step) => {
              startedSteps.push(step.id ?? "<anonymous>")
              return {
                exitCode: 0,
                providerEvents: [],
                result: null,
                stderr: "",
                stdout: "",
                termination: "completed",
              }
            },
          },
          invocationInputs: {},
          parentEnv: process.env,
          project,
          projectRoot: root,
          workflow: parentWorkflow!,
        }),
      ).rejects.toThrow("Step `call_child` cannot invoke workflow `child`: inputs.enabled must be a boolean")

      expect(startedSteps).toEqual([])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("interrupts sibling parallel branches after a thrown branch error", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-parallel-"))
    const nodeStatuses = new Map<string, string>()

    try {
      await expect(
        runWorkflow({
          internals: {
            runActionStep: async (step, _context, options) => {
              if (step.id === "slow") {
                await new Promise((resolve, reject) => {
                  const timer = setTimeout(resolve, 100)
                  const onAbort = () => {
                    clearTimeout(timer)
                    reject(interrupt("slow branch interrupted"))
                  }
                  if (options.signal?.aborted) {
                    onAbort()
                    return
                  }
                  options.signal?.addEventListener("abort", onAbort, { once: true })
                })
                return {
                  exitCode: 0,
                  providerEvents: [],
                  result: "finished",
                  stderr: "",
                  stdout: "finished",
                  termination: "completed",
                }
              }

              if (step.id === "boom") {
                await new Promise((resolve) => setTimeout(resolve, 10))
                throw new Error("branch exploded")
              }

              throw new Error(`unexpected step ${step.id ?? "<anonymous>"}`)
            },
          },
          invocationInputs: {},
          onEvent: (event: RunEvent) => {
            if (event.kind === "node_completed" && event.node.user_id != null) {
              nodeStatuses.set(event.node.user_id, event.node.status)
            }
          },
          parentEnv: process.env,
          projectRoot: root,
          workflow: {
            id: "parallel-join",
            steps: [
              {
                branches: [
                  {
                    id: "left",
                    steps: [
                      {
                        id: "slow",
                        type: "shell",
                        with: {
                          command: "slow",
                          result: "text",
                        },
                      },
                    ],
                  },
                  {
                    id: "right",
                    steps: [
                      {
                        id: "boom",
                        type: "shell",
                        with: {
                          command: "boom",
                          result: "text",
                        },
                      },
                    ],
                  },
                ],
                id: "parallel",
                type: "parallel",
              },
            ],
          },
        }),
      ).rejects.toThrow("branch exploded")

      expect(nodeStatuses.get("slow")).toBe("interrupted")
      expect(nodeStatuses.get("boom")).toBe("failed")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("aborts the active workflow when the root signal is interrupted", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-root-interrupt-"))
    const controller = new AbortController()
    let notifyStepStarted: (() => void) | undefined

    try {
      const stepStarted = new Promise<void>((resolve) => {
        notifyStepStarted = resolve
      })

      const execution = runWorkflow({
        internals: {
          runActionStep: async (step, _context, options) => {
            if (step.id !== "wait") {
              throw new Error(`unexpected step ${step.id ?? "<anonymous>"}`)
            }

            await new Promise<void>((resolve, reject) => {
              const onAbort = () => reject(interrupt("root signal interrupted step"))
              if (options.signal?.aborted) {
                onAbort()
                return
              }
              options.signal?.addEventListener("abort", onAbort, { once: true })
              notifyStepStarted?.()
            })

            return {
              exitCode: 0,
              providerEvents: [],
              result: "finished",
              stderr: "",
              stdout: "finished",
              termination: "completed",
            }
          },
        },
        invocationInputs: {},
        parentEnv: process.env,
        projectRoot: root,
        signal: controller.signal,
        workflow: {
          id: "root-interrupt",
          steps: [
            {
              id: "wait",
              type: "shell",
              with: {
                command: "wait",
                result: "text",
              },
            },
          ],
        },
      })

      await stepStarted
      controller.abort(interrupt("workflow interrupted by operator"))

      const snapshot = await execution
      expect(snapshot.status).toBe("aborted")
      expect(snapshot.reason).toBe("aborted")
      expect(snapshot.nodes.find((node) => node.user_id === "wait")?.status).toBe("interrupted")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("aborts a pending barrier when its control signal fires", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-barrier-abort-"))
    const controller = new AbortController()
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("timed out waiting for barrier abort")), 500)
    })

    try {
      const snapshot = await Promise.race([
        runWorkflow({
          controlHandler: async (request) => {
            if (request.kind !== "step_barrier") {
              throw new Error(`unexpected control request ${request.kind}`)
            }

            queueMicrotask(() => controller.abort(interrupt("workflow interrupted by operator")))
            return await new Promise<never>(() => {})
          },
          internals: {
            runActionStep: async () => ({
              exitCode: 0,
              providerEvents: [],
              result: "ok",
              stderr: "",
              stdout: "ok",
              termination: "completed",
            }),
          },
          invocationInputs: {},
          parentEnv: process.env,
          projectRoot: root,
          signal: controller.signal,
          workflow: {
            id: "barrier-abort",
            steps: [
              {
                id: "first",
                type: "shell",
                with: {
                  command: "first",
                  result: "text",
                },
              },
            ],
          },
        }),
        timeout,
      ])

      expect(snapshot.status).toBe("aborted")
      expect(snapshot.reason).toBe("aborted")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("aborts a pending interaction when its control signal fires", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-interaction-abort-"))
    const controller = new AbortController()
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("timed out waiting for interaction abort")), 500)
    })

    try {
      const snapshot = await Promise.race([
        runWorkflow({
          controlHandler: async (request) => {
            if (request.kind === "step_barrier") {
              return { action: "continue", kind: "step_barrier" }
            }

            queueMicrotask(() => controller.abort(interrupt("workflow interrupted by operator")))
            return await new Promise<never>(() => {})
          },
          internals: {
            runActionStep: async (_step, _context, options) => {
              if (options.interactionHandler === undefined) {
                throw new Error("interactionHandler missing")
              }

              await options.interactionHandler({
                decisions: [
                  { intent: "approve", value: "approve" },
                  { intent: "deny", value: "deny" },
                ],
                itemId: "item-1",
                kind: "approval",
                message: "Approve the step",
                requestId: "approval-1",
                requestKind: "command_execution",
                turnId: "turn-1",
              })

              return {
                exitCode: 0,
                providerEvents: [],
                result: "ok",
                stderr: "",
                stdout: "ok",
                termination: "completed",
              }
            },
          },
          invocationInputs: {},
          parentEnv: process.env,
          projectRoot: root,
          signal: controller.signal,
          workflow: {
            id: "interaction-abort",
            steps: [
              {
                id: "needs_approval",
                type: "codex",
                with: {
                  action: "run",
                  prompt: "needs approval",
                },
              },
            ],
          },
        }),
        timeout,
      ])

      expect(snapshot.status).toBe("aborted")
      expect(snapshot.reason).toBe("aborted")
      expect(snapshot.nodes.find((node) => node.user_id === "needs_approval")?.status).toBe("interrupted")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("evaluates loop exports with the current iteration run context", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-loop-exports-"))

    try {
      const snapshot = await runWorkflow({
        internals: {
          runActionStep: async () => ({
            exitCode: 0,
            providerEvents: [],
            result: "ok",
            stderr: "",
            stdout: "ok",
            termination: "completed",
          }),
        },
        invocationInputs: {},
        parentEnv: process.env,
        projectRoot: root,
        workflow: {
          id: "loop-exports",
          steps: [
            {
              exports: {
                iteration: "${{ run.iteration }}",
                max_iterations: "${{ run.max_iterations }}",
                node_path: "${{ run.node_path }}",
              },
              id: "retry",
              max: 3,
              steps: [
                {
                  id: "work",
                  type: "shell",
                  with: {
                    command: "work",
                    result: "text",
                  },
                },
              ],
              type: "loop",
              until: "${{ true }}",
            },
          ],
        },
      })

      expect(snapshot.nodes.find((node) => node.user_id === "retry")?.result).toEqual({
        iteration: 1,
        max_iterations: 3,
        node_path: "/0",
      })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("stores loop progress on the loop node snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-loop-progress-"))

    try {
      const snapshot = await runWorkflow({
        internals: {
          runActionStep: async () => ({
            exitCode: 0,
            providerEvents: [],
            result: "ok",
            stderr: "",
            stdout: "ok",
            termination: "completed",
          }),
        },
        invocationInputs: {},
        parentEnv: process.env,
        projectRoot: root,
        workflow: {
          id: "loop-progress",
          steps: [
            {
              id: "loop",
              max: 3,
              steps: [
                {
                  id: "inside_loop",
                  type: "shell",
                  with: {
                    command: "inside-loop",
                    result: "text",
                  },
                },
              ],
              type: "loop",
              until: "${{ run.iteration == 2 }}",
            },
          ],
        },
      })

      expect(snapshot.status).toBe("succeeded")
      expect(snapshot.nodes.find((node) => node.user_id === "loop")?.progress).toEqual({
        current_iteration: 2,
        max_iterations: 3,
      })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("pauses at step barriers and continues in order", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-barrier-"))
    const barriers: Array<{ next: string[]; reason: string }> = []

    try {
      const snapshot = await runWorkflow({
        controlHandler: async (request) => {
          if (request.kind === "step_barrier") {
            barriers.push({
              next: request.barrier.next.map((step) => step.user_id ?? step.node_path),
              reason: request.barrier.reason,
            })
            return { action: "continue", kind: "step_barrier" }
          }
          throw new Error(`unexpected control request ${request.kind}`)
        },
        internals: {
          runActionStep: async () => ({
            exitCode: 0,
            providerEvents: [],
            result: "ok",
            stderr: "",
            stdout: "ok",
            termination: "completed",
          }),
        },
        invocationInputs: {},
        parentEnv: process.env,
        projectRoot: root,
        workflow: {
          id: "barrier-sequence",
          steps: [
            {
              id: "first",
              type: "shell",
              with: {
                command: "first",
                result: "text",
              },
            },
            {
              id: "second",
              type: "shell",
              with: {
                command: "second",
                result: "text",
              },
            },
          ],
        },
      })

      expect(snapshot.status).toBe("succeeded")
      expect(barriers).toEqual([
        { next: ["first"], reason: "run_started" },
        { next: ["second"], reason: "step_completed" },
      ])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("preserves completed context and control reason across nested blocks", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-nested-barrier-"))
    const barriers: Array<{
      completedKind: string | null
      completedUserId: string | null
      next: string[]
      reason: string
    }> = []

    try {
      const snapshot = await runWorkflow({
        controlHandler: async (request) => {
          if (request.kind !== "step_barrier") {
            throw new Error(`unexpected control request ${request.kind}`)
          }
          barriers.push({
            completedKind: request.barrier.completed?.node_kind ?? null,
            completedUserId: request.barrier.completed?.user_id ?? null,
            next: request.barrier.next.map((node) => node.user_id ?? node.node_path),
            reason: request.barrier.reason,
          })
          return { action: "continue", kind: "step_barrier" }
        },
        internals: {
          runActionStep: async (step) => ({
            exitCode: 0,
            providerEvents: [],
            result: step.id ?? "ok",
            stderr: "",
            stdout: String(step.id ?? "ok"),
            termination: "completed",
          }),
        },
        invocationInputs: {},
        parentEnv: process.env,
        projectRoot: root,
        workflow: {
          id: "nested-barrier-context",
          steps: [
            {
              id: "before_group",
              type: "shell",
              with: {
                command: "before-group",
                result: "text",
              },
            },
            {
              id: "group",
              steps: [
                {
                  id: "inside_group",
                  type: "shell",
                  with: {
                    command: "inside-group",
                    result: "text",
                  },
                },
              ],
              type: "group",
            },
            {
              cases: [
                {
                  if: "${{ true }}",
                  steps: [
                    {
                      id: "inside_branch",
                      type: "shell",
                      with: {
                        command: "inside-branch",
                        result: "text",
                      },
                    },
                  ],
                },
              ],
              id: "branch",
              type: "branch",
            },
            {
              id: "loop",
              max: 2,
              steps: [
                {
                  id: "inside_loop",
                  type: "shell",
                  with: {
                    command: "inside-loop",
                    result: "text",
                  },
                },
              ],
              type: "loop",
              until: "${{ run.iteration == 2 }}",
            },
          ],
        },
      })

      expect(snapshot.status).toBe("succeeded")
      expect(barriers).toEqual([
        {
          completedKind: null,
          completedUserId: null,
          next: ["before_group"],
          reason: "run_started",
        },
        {
          completedKind: "shell",
          completedUserId: "before_group",
          next: ["inside_group"],
          reason: "step_completed",
        },
        {
          completedKind: "group",
          completedUserId: "group",
          next: ["inside_branch"],
          reason: "branch_selected",
        },
        {
          completedKind: "branch",
          completedUserId: "branch",
          next: ["inside_loop"],
          reason: "loop_iteration_started",
        },
        {
          completedKind: "shell",
          completedUserId: "inside_loop",
          next: ["inside_loop"],
          reason: "loop_iteration_started",
        },
      ])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("does not raise barriers for steps that will be skipped", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-skip-barrier-"))
    const barriers: string[][] = []

    try {
      await runWorkflow({
        controlHandler: async (request) => {
          if (request.kind !== "step_barrier") {
            throw new Error(`unexpected control request ${request.kind}`)
          }
          barriers.push(request.barrier.next.map((node) => node.user_id ?? node.node_path))
          return { action: "continue", kind: "step_barrier" }
        },
        internals: {
          runActionStep: async () => ({
            exitCode: 0,
            providerEvents: [],
            result: "ok",
            stderr: "",
            stdout: "ok",
            termination: "completed",
          }),
        },
        invocationInputs: {},
        parentEnv: process.env,
        projectRoot: root,
        workflow: {
          id: "skip-barrier",
          steps: [
            {
              id: "skip_action",
              if: "${{ false }}",
              type: "shell",
              with: {
                command: "skip-action",
                result: "text",
              },
            },
            {
              id: "skip_parallel",
              if: "${{ false }}",
              type: "parallel",
              branches: [
                {
                  id: "left",
                  steps: [
                    {
                      id: "left_inner",
                      type: "shell",
                      with: {
                        command: "left-inner",
                        result: "text",
                      },
                    },
                  ],
                },
              ],
            },
            {
              id: "run_now",
              type: "shell",
              with: {
                command: "run-now",
                result: "text",
              },
            },
          ],
        },
      })

      expect(barriers).toEqual([["run_now"]])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("records branch_case snapshots for selected and skipped cases", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-branch-case-"))

    try {
      const snapshot = await runWorkflow({
        invocationInputs: {},
        parentEnv: process.env,
        projectRoot: root,
        workflow: {
          id: "branch-case-snapshots",
          steps: [
            {
              id: "choose",
              type: "branch",
              cases: [
                {
                  if: "${{ true }}",
                  exports: {
                    winner: '${{ "fast" }}',
                  },
                  steps: [],
                },
                {
                  else: true,
                  steps: [
                    {
                      id: "slow",
                      type: "shell",
                      with: {
                        command: "echo slow",
                        result: "text",
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      })

      expect(snapshot.status).toBe("succeeded")
      expect(snapshot.nodes.find((node) => node.node_path === "/0/0")).toMatchObject({
        node_kind: "branch_case",
        result: { winner: "fast" },
        status: "succeeded",
      })
      expect(snapshot.nodes.find((node) => node.node_path === "/0/1")).toMatchObject({
        node_kind: "branch_case",
        status: "skipped",
      })
      expect(snapshot.nodes.find((node) => node.node_path === "/0/1/0")?.status).toBe("skipped")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("records skipped branch_case snapshots when no branch case matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-branch-case-no-match-"))

    try {
      const snapshot = await runWorkflow({
        invocationInputs: {},
        parentEnv: process.env,
        projectRoot: root,
        workflow: {
          id: "branch-case-no-match",
          steps: [
            {
              id: "choose",
              type: "branch",
              cases: [
                {
                  if: "${{ false }}",
                  steps: [{ id: "fast", type: "shell", with: { command: "echo fast", result: "text" } }],
                },
                {
                  if: "${{ false }}",
                  steps: [{ id: "slow", type: "shell", with: { command: "echo slow", result: "text" } }],
                },
              ],
            },
            {
              id: "after",
              type: "shell",
              with: {
                command: "echo after",
                result: "text",
              },
            },
          ],
        },
      })

      expect(snapshot.status).toBe("succeeded")
      expect(snapshot.nodes.find((node) => node.node_path === "/0")).toMatchObject({
        node_kind: "branch",
        status: "skipped",
      })
      expect(snapshot.nodes.find((node) => node.node_path === "/0/0")).toMatchObject({
        node_kind: "branch_case",
        status: "skipped",
      })
      expect(snapshot.nodes.find((node) => node.node_path === "/0/1")).toMatchObject({
        node_kind: "branch_case",
        status: "skipped",
      })
      expect(snapshot.nodes.find((node) => node.node_path === "/0/0/0")?.status).toBe("skipped")
      expect(snapshot.nodes.find((node) => node.node_path === "/0/1/0")?.status).toBe("skipped")
      expect(snapshot.nodes.find((node) => node.node_path === "/1")).toMatchObject({
        node_kind: "shell",
        result: "after\n",
        status: "succeeded",
      })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("surfaces parallel frontiers as a single barrier", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-parallel-barrier-"))
    const barrierNext: string[][] = []

    try {
      await runWorkflow({
        controlHandler: async (request) => {
          if (request.kind === "step_barrier") {
            barrierNext.push(request.barrier.next.map((step) => step.user_id ?? step.node_path))
            return { action: "continue", kind: "step_barrier" }
          }
          throw new Error(`unexpected control request ${request.kind}`)
        },
        internals: {
          runActionStep: async () => ({
            exitCode: 0,
            providerEvents: [],
            result: "ok",
            stderr: "",
            stdout: "ok",
            termination: "completed",
          }),
        },
        invocationInputs: {},
        parentEnv: process.env,
        projectRoot: root,
        workflow: {
          id: "parallel-barrier",
          steps: [
            {
              id: "fanout",
              type: "parallel",
              branches: [
                {
                  id: "left",
                  steps: [
                    {
                      id: "left_step",
                      type: "shell",
                      with: {
                        command: "left",
                        result: "text",
                      },
                    },
                    {
                      id: "left_after",
                      type: "shell",
                      with: {
                        command: "left-after",
                        result: "text",
                      },
                    },
                  ],
                },
                {
                  id: "right",
                  steps: [
                    {
                      id: "right_step",
                      type: "shell",
                      with: {
                        command: "right",
                        result: "text",
                      },
                    },
                    {
                      id: "right_after",
                      type: "shell",
                      with: {
                        command: "right-after",
                        result: "text",
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      })

      expect(barrierNext[0]).toEqual(["left_step", "right_step"])
      expect(barrierNext).toHaveLength(1)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("resolves actionable leaves for nested control steps inside parallel frontiers", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-parallel-nested-frontier-"))
    const barrierNext: string[][] = []

    try {
      await runWorkflow({
        controlHandler: async (request) => {
          if (request.kind === "step_barrier") {
            barrierNext.push(request.barrier.next.map((step) => step.user_id ?? step.node_path))
            return { action: "continue", kind: "step_barrier" }
          }
          throw new Error(`unexpected control request ${request.kind}`)
        },
        internals: {
          runActionStep: async () => ({
            exitCode: 0,
            providerEvents: [],
            result: "ok",
            stderr: "",
            stdout: "ok",
            termination: "completed",
          }),
        },
        invocationInputs: {},
        parentEnv: process.env,
        projectRoot: root,
        workflow: {
          id: "parallel-nested-frontier",
          env: {
            TARGET_BRANCH: "selected",
          },
          steps: [
            {
              id: "fanout",
              type: "parallel",
              env: {
                TARGET_BRANCH: "${{ env.TARGET_BRANCH }}",
              },
              branches: [
                {
                  id: "left",
                  steps: [
                    {
                      id: "left_group",
                      type: "group",
                      steps: [
                        {
                          id: "left_leaf",
                          type: "shell",
                          with: {
                            command: "left",
                            result: "text",
                          },
                        },
                      ],
                    },
                  ],
                },
                {
                  id: "middle",
                  steps: [
                    {
                      id: "loop_control",
                      max: 1,
                      steps: [
                        {
                          id: "loop_leaf",
                          type: "shell",
                          with: {
                            command: "middle",
                            result: "text",
                          },
                        },
                      ],
                      type: "loop",
                      until: "${{ true }}",
                    },
                  ],
                },
                {
                  id: "right",
                  steps: [
                    {
                      id: "branch_control",
                      type: "branch",
                      cases: [
                        {
                          if: "${{ env.TARGET_BRANCH == 'selected' }}",
                          steps: [
                            {
                              id: "branch_leaf",
                              type: "shell",
                              with: {
                                command: "right",
                                result: "text",
                              },
                            },
                          ],
                        },
                        {
                          else: true,
                          steps: [
                            {
                              id: "branch_else_leaf",
                              type: "shell",
                              with: {
                                command: "wrong-right",
                                result: "text",
                              },
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      })

      expect(barrierNext[0]).toEqual(["left_leaf", "loop_leaf", "branch_leaf"])
      expect(barrierNext).toHaveLength(1)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("includes workflow-backed branches in parallel barrier frontiers", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-parallel-workflow-frontier-"))
    const barrierNext: string[][] = []

    try {
      const project = workflowProject([
        {
          workflow: {
            id: "child",
            steps: [
              {
                id: "child_leaf",
                type: "shell",
                with: {
                  command: "child",
                  result: "text",
                },
              },
            ],
          },
        },
        {
          workflow: {
            id: "parent",
            steps: [
              {
                id: "fanout",
                type: "parallel",
                branches: [
                  {
                    id: "left",
                    steps: [
                      {
                        id: "call_child",
                        type: "workflow",
                        with: {
                          workflow: "child",
                        },
                      },
                    ],
                  },
                  {
                    id: "right",
                    steps: [
                      {
                        id: "right_leaf",
                        type: "shell",
                        with: {
                          command: "right",
                          result: "text",
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ])

      const workflow = project.files.find((file) => file.workflow.id === "parent")?.workflow
      expect(workflow).toBeDefined()

      await runWorkflow({
        controlHandler: async (request) => {
          if (request.kind === "step_barrier") {
            barrierNext.push(request.barrier.next.map((step) => step.user_id ?? step.node_path))
            return { action: "continue", kind: "step_barrier" }
          }
          throw new Error(`unexpected control request ${request.kind}`)
        },
        internals: {
          runActionStep: async () => ({
            exitCode: 0,
            providerEvents: [],
            result: "ok",
            stderr: "",
            stdout: "ok",
            termination: "completed",
          }),
        },
        invocationInputs: {},
        parentEnv: process.env,
        project,
        projectRoot: root,
        workflow: workflow!,
      })

      expect(barrierNext[0]).toEqual(["child_leaf", "right_leaf"])
      expect(barrierNext).toHaveLength(1)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("does not start codex for an untaken branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-branch-lazy-codex-"))

    try {
      const binDir = await installFakeCodex(root, {
        versionOutput: "codex-cli 0.113.0",
      })

      const snapshot = await runWorkflow({
        invocationInputs: {},
        parentEnv: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
        projectRoot: root,
        workflow: {
          id: "lazy-codex-branch",
          steps: [
            {
              id: "choose",
              type: "branch",
              cases: [
                {
                  if: "${{ true }}",
                  steps: [
                    {
                      id: "shell_only",
                      type: "shell",
                      with: {
                        command: "printf 'ok'",
                        result: "text",
                      },
                    },
                  ],
                },
                {
                  else: true,
                  steps: [
                    {
                      id: "never_run_codex",
                      type: "codex",
                      with: {
                        action: "run",
                        prompt: "Should never run",
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      })

      expect(snapshot.status).toBe("succeeded")
      expect(snapshot.nodes.find((node) => node.user_id === "shell_only")?.stdout).toBe("ok")
      expect(snapshot.nodes.find((node) => node.user_id === "never_run_codex")?.status).toBe("skipped")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("starts codex from the executing step environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-step-env-codex-"))

    try {
      const binDir = await installFakeCodex(root, {
        turnStart: {
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

      const snapshot = await runWorkflow({
        invocationInputs: {},
        parentEnv: {
          ...process.env,
          CODEX_BIN_DIR: binDir,
          PATH: "",
        },
        projectRoot: root,
        workflow: {
          id: "step-env-codex",
          steps: [
            {
              id: "agent",
              env: {
                PATH: "${{ env.CODEX_BIN_DIR }}",
              },
              type: "codex",
              with: {
                action: "run",
                prompt: "Do the work",
              },
            },
          ],
        },
      })

      expect(snapshot.status).toBe("succeeded")
      expect(snapshot.nodes.find((node) => node.user_id === "agent")?.stdout).toBe("done")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("routes provider interactions through the workflow control handler", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-codex-interactions-"))
    const requests: string[] = []

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

      const snapshot = await runWorkflow({
        controlHandler: async (request) => {
          if (request.kind === "step_barrier") {
            return { action: "continue", kind: "step_barrier" }
          }
          requests.push(request.interaction.kind)
          switch (request.interaction.kind) {
            case "approval":
              return { decision: "accept", kind: "approval" }
            case "user_input":
              return { answers: { choice: { answers: ["A"] } }, kind: "user_input" }
            case "elicitation":
              return { action: "accept", content: {}, kind: "elicitation" }
          }
        },
        invocationInputs: {},
        parentEnv: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
        projectRoot: root,
        workflow: {
          id: "codex-control",
          steps: [
            {
              id: "agent",
              type: "codex",
              with: {
                action: "run",
                prompt: "Do the work",
              },
            },
          ],
        },
      })

      expect(snapshot.status).toBe("succeeded")
      expect(requests).toEqual(["approval", "user_input"])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("supports concurrent codex turns in parallel branches and preserves branch-local interactions", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-codex-parallel-"))
    const interactions: string[] = []

    try {
      const binDir = await installFakeCodex(root, {
        turnStart: {
          steps: [
            {
              kind: "request",
              method: "item/tool/requestUserInput",
              params: {
                threadId: "__THREAD_ID__",
                turnId: "__TURN_ID__",
                itemId: "input_shared",
                questions: [
                  {
                    id: "answer",
                    header: "Answer",
                    question: "Provide branch-local input",
                    isOther: false,
                    isSecret: false,
                  },
                ],
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
                  id: "msg_done",
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

      const snapshot = await runWorkflow({
        controlHandler: async (request) => {
          if (request.kind === "step_barrier") {
            return { action: "continue", kind: "step_barrier" }
          }
          interactions.push(`${request.interaction.user_id}:${request.interaction.kind}`)
          if (request.interaction.kind !== "user_input") {
            throw new Error(`unexpected interaction ${request.interaction.kind}`)
          }
          return {
            answers: {
              answer: {
                answers: [String(request.interaction.user_id)],
              },
            },
            kind: "user_input",
          }
        },
        invocationInputs: {},
        parentEnv: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
        projectRoot: root,
        workflow: {
          id: "parallel-codex",
          steps: [
            {
              id: "fanout",
              type: "parallel",
              branches: [
                {
                  id: "left",
                  steps: [
                    {
                      id: "left_agent",
                      type: "codex",
                      with: {
                        action: "run",
                        prompt: "left",
                      },
                    },
                  ],
                },
                {
                  id: "right",
                  steps: [
                    {
                      id: "right_agent",
                      type: "codex",
                      with: {
                        action: "run",
                        prompt: "right",
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      })

      expect(snapshot.status).toBe("succeeded")
      expect(interactions.sort()).toEqual(["left_agent:user_input", "right_agent:user_input"])
      expect(snapshot.nodes.find((node) => node.user_id === "left_agent")?.status).toBe("succeeded")
      expect(snapshot.nodes.find((node) => node.user_id === "right_agent")?.status).toBe("succeeded")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("interrupts a hanging codex sibling when another parallel branch fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-codex-parallel-failfast-"))

    try {
      const binDir = await installFakeCodex(root, {
        turnInterrupt: {
          steps: [],
        },
        turnStart: {
          steps: [],
        },
      })

      const snapshot = await runWorkflow({
        controlHandler: async (request) => {
          if (request.kind === "step_barrier") {
            return { action: "continue", kind: "step_barrier" }
          }
          throw new Error(`unexpected control request ${request.kind}`)
        },
        invocationInputs: {},
        parentEnv: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
        projectRoot: root,
        workflow: {
          id: "parallel-codex-failfast",
          steps: [
            {
              id: "fanout",
              type: "parallel",
              branches: [
                {
                  id: "left",
                  steps: [
                    {
                      id: "left_agent",
                      type: "codex",
                      with: {
                        action: "run",
                        prompt: "left",
                      },
                    },
                  ],
                },
                {
                  id: "right",
                  steps: [
                    {
                      id: "right_fail",
                      type: "shell",
                      with: {
                        command: "printf 'boom'; exit 1",
                        result: "text",
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      })

      expect(snapshot.status).toBe("failed")
      expect(snapshot.nodes.find((node) => node.user_id === "right_fail")?.status).toBe("failed")
      expect(snapshot.nodes.find((node) => node.user_id === "left_agent")?.status).toBe("interrupted")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("does not surface branch-local barriers before parallel interactions", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-parallel-interaction-order-"))
    let resolveLeftFirst: (() => void) | undefined
    const leftFirstCompleted = new Promise<void>((resolve) => {
      resolveLeftFirst = resolve
    })
    const controlRequests: string[] = []

    try {
      const snapshot = await runWorkflow({
        controlHandler: async (request) => {
          if (request.kind === "step_barrier") {
            const nextUserIds = request.barrier.next.map((node) => node.user_id ?? node.node_path).join(",")
            controlRequests.push(`barrier:${nextUserIds}`)
            if (nextUserIds.includes("left_second")) {
              throw new Error("unexpected branch-local barrier inside parallel execution")
            }
            return { action: "continue", kind: "step_barrier" }
          }

          controlRequests.push(`interaction:${request.interaction.kind}`)
          return {
            answers: {
              answer: {
                answers: ["ok"],
              },
            },
            kind: "user_input",
          }
        },
        internals: {
          runActionStep: async (step, _context, options) => {
            if (step.id === "left_first") {
              resolveLeftFirst?.()
            }
            if (step.id === "right_ask") {
              await leftFirstCompleted
              await options.interactionHandler?.({
                itemId: "input-right",
                kind: "user_input",
                questions: [
                  {
                    header: "Answer",
                    id: "answer",
                    isOther: false,
                    isSecret: false,
                    options: null,
                    question: "Need input",
                  },
                ],
                requestId: "req-right",
                turnId: "turn-right",
              })
            }

            return {
              exitCode: 0,
              providerEvents: [],
              result: step.id,
              stderr: "",
              stdout: String(step.id ?? ""),
              termination: "completed",
            }
          },
        },
        invocationInputs: {},
        parentEnv: process.env,
        projectRoot: root,
        workflow: {
          id: "parallel-interaction-order",
          steps: [
            {
              id: "fanout",
              type: "parallel",
              branches: [
                {
                  id: "left",
                  steps: [
                    {
                      id: "left_first",
                      type: "shell",
                      with: { command: "left-first", result: "text" },
                    },
                    {
                      id: "left_second",
                      type: "shell",
                      with: { command: "left-second", result: "text" },
                    },
                  ],
                },
                {
                  id: "right",
                  steps: [
                    {
                      id: "right_ask",
                      type: "shell",
                      with: { command: "right-ask", result: "text" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      })

      expect(snapshot.status).toBe("succeeded")
      expect(controlRequests).toEqual(["barrier:left_first,right_ask", "interaction:user_input"])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("cancels an in-flight interaction after sibling failure in parallel", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-parallel-interaction-cancel-"))
    let resolveInteractionReached: (() => void) | undefined
    const interactionReached = new Promise<void>((resolve) => {
      resolveInteractionReached = resolve
    })
    let interactionCancelled = false

    try {
      const snapshot = await runWorkflow({
        controlHandler: async (request) => {
          if (request.kind === "step_barrier") {
            return { action: "continue", kind: "step_barrier" }
          }

          resolveInteractionReached?.()
          await new Promise<never>((_resolve, reject) => {
            request.signal.addEventListener(
              "abort",
              () => {
                interactionCancelled = true
                reject(new DOMException("interaction cancelled", "AbortError"))
              },
              { once: true },
            )
          })
          throw new Error("cancelled interaction unexpectedly resolved")
        },
        internals: {
          runActionStep: async (step, _context, options) => {
            if (step.id === "left_wait") {
              await options.interactionHandler?.({
                itemId: "input-left",
                kind: "user_input",
                questions: [
                  {
                    header: "Left",
                    id: "left",
                    isOther: false,
                    isSecret: false,
                    options: null,
                    question: "Answer left",
                  },
                ],
                requestId: "req-left",
                turnId: "turn-left",
              })
              return {
                exitCode: 0,
                providerEvents: [],
                result: "left",
                stderr: "",
                stdout: "left",
                termination: "completed",
              }
            }

            if (step.id === "right_fail") {
              await interactionReached
              return {
                exitCode: 1,
                providerEvents: [],
                result: null,
                stderr: "boom",
                stdout: "",
                termination: "completed",
              }
            }

            throw new Error(`unexpected step ${step.id ?? "<anonymous>"}`)
          },
        },
        invocationInputs: {},
        parentEnv: process.env,
        projectRoot: root,
        workflow: {
          id: "parallel-interaction-cancel",
          steps: [
            {
              id: "fanout",
              type: "parallel",
              branches: [
                {
                  id: "left",
                  steps: [
                    {
                      id: "left_wait",
                      type: "shell",
                      with: { command: "left-wait", result: "text" },
                    },
                  ],
                },
                {
                  id: "right",
                  steps: [
                    {
                      id: "right_fail",
                      type: "shell",
                      with: { command: "right-fail", result: "text" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      })

      expect(snapshot.status).toBe("failed")
      expect(snapshot.active_interaction).toBeNull()
      expect(interactionCancelled).toBe(true)
      expect(snapshot.nodes.find((node) => node.user_id === "left_wait")?.status).toBe("interrupted")
      expect(snapshot.nodes.find((node) => node.user_id === "right_fail")?.status).toBe("failed")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("includes codex preview data in step barriers", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-barrier-preview-"))
    const barriers: RunEvent[] = []

    try {
      await runWorkflow({
        controlHandler: async (request) => {
          if (request.kind !== "step_barrier") {
            throw new Error(`unexpected control request ${request.kind}`)
          }
          return { action: "continue", kind: "step_barrier" }
        },
        internals: {
          runActionStep: async () => ({
            exitCode: 0,
            providerEvents: [],
            result: "ok",
            stderr: "",
            stdout: "ok",
            termination: "completed",
          }),
        },
        invocationInputs: { branch: "main" },
        onEvent: (event) => {
          if (event.kind === "barrier_reached") {
            barriers.push(event)
          }
        },
        parentEnv: process.env,
        projectRoot: root,
        workflow: {
          id: "barrier-preview",
          steps: [
            {
              env: {
                BRANCH: "${{ inputs.branch }}",
              },
              id: "review",
              type: "codex",
              with: {
                action: "run",
                model: "gpt-5.4",
                prompt: "Review branch ${{ env.BRANCH }}",
              },
            },
          ],
        },
      })

      const firstBarrier = barriers[0]
      expect(firstBarrier?.kind).toBe("barrier_reached")
      if (firstBarrier?.kind !== "barrier_reached") {
        throw new Error("missing barrier")
      }
      expect(firstBarrier.barrier.next[0]).toMatchObject({
        action: "run",
        cwd: root,
        model: "gpt-5.4",
        prompt_preview: "Review branch main",
        user_id: "review",
      })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("detaches event and control snapshots from later state mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-detached-events-"))
    let runStartedSnapshot: Extract<RunEvent, { kind: "run_started" }>["snapshot"] | undefined
    let barrierEvent: Extract<RunEvent, { kind: "barrier_reached" }> | undefined
    let barrierRequestSnapshot:
      | {
          barrierId: string
          snapshot: Awaited<ReturnType<typeof executeWorkflow>>
        }
      | undefined

    try {
      const finalSnapshot = await runWorkflow({
        controlHandler: async (request) => {
          if (request.kind !== "step_barrier") {
            throw new Error(`unexpected control request ${request.kind}`)
          }
          barrierRequestSnapshot = {
            barrierId: request.barrier.barrier_id,
            snapshot: request.snapshot,
          }
          return { action: "continue", kind: "step_barrier" }
        },
        internals: {
          runActionStep: async () => ({
            exitCode: 0,
            providerEvents: [],
            result: "ok",
            stderr: "",
            stdout: "ok",
            termination: "completed",
          }),
        },
        invocationInputs: {},
        onEvent: (event) => {
          if (event.kind === "run_started") {
            runStartedSnapshot = event.snapshot
          }
          if (event.kind === "barrier_reached") {
            barrierEvent = event
          }
        },
        parentEnv: process.env,
        projectRoot: root,
        workflow: {
          id: "detached-events",
          steps: [
            {
              id: "first",
              type: "shell",
              with: {
                command: "first",
                result: "text",
              },
            },
          ],
        },
      })

      expect(finalSnapshot.status).toBe("succeeded")
      expect(runStartedSnapshot).toMatchObject({
        active_barrier: null,
        nodes: [],
        phase: "running",
        status: "running",
      })
      expect(barrierEvent?.snapshot).toMatchObject({
        phase: "waiting_for_barrier",
        status: "running",
      })
      expect(barrierEvent?.snapshot.active_barrier?.barrier_id).toBe(barrierEvent?.barrier.barrier_id)
      expect(barrierRequestSnapshot?.snapshot).toMatchObject({
        phase: "waiting_for_barrier",
        status: "running",
      })
      expect(barrierRequestSnapshot?.snapshot.active_barrier?.barrier_id).toBe(barrierRequestSnapshot?.barrierId)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("keeps run phase running while sibling branches continue in parallel", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-waiting-phase-"))
    let resolveLeftSecondStarted: (() => void) | undefined
    const leftSecondStarted = new Promise<void>((resolve) => {
      resolveLeftSecondStarted = resolve
    })
    let resolveRightFinish: (() => void) | undefined
    const rightFinished = new Promise<void>((resolve) => {
      resolveRightFinish = resolve
    })
    const completedPhases = new Map<string, string>()

    try {
      await runWorkflow({
        controlHandler: async (request) => {
          if (request.kind === "step_barrier") {
            return { action: "continue", kind: "step_barrier" }
          }
          throw new Error(`unexpected control request ${request.kind}`)
        },
        internals: {
          runActionStep: async (step) => {
            if (step.id === "left_second") {
              resolveLeftSecondStarted?.()
              await rightFinished
            }
            if (step.id === "right_first") {
              await leftSecondStarted
              resolveRightFinish?.()
            }

            return {
              exitCode: 0,
              providerEvents: [],
              result: step.id,
              stderr: "",
              stdout: String(step.id ?? ""),
              termination: "completed",
            }
          },
        },
        invocationInputs: {},
        onEvent: (event) => {
          if (event.kind === "node_completed" && event.node.user_id != null) {
            completedPhases.set(event.node.user_id, event.snapshot.phase)
          }
        },
        parentEnv: process.env,
        projectRoot: root,
        workflow: {
          id: "waiting-phase",
          steps: [
            {
              id: "fanout",
              type: "parallel",
              branches: [
                {
                  id: "left",
                  steps: [
                    {
                      id: "left_first",
                      type: "shell",
                      with: { command: "left-first", result: "text" },
                    },
                    {
                      id: "left_second",
                      type: "shell",
                      with: { command: "left-second", result: "text" },
                    },
                  ],
                },
                {
                  id: "right",
                  steps: [
                    {
                      id: "right_first",
                      type: "shell",
                      with: { command: "right-first", result: "text" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      })

      expect(completedPhases.get("right_first")).toBe("running")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("does not queue branch-local barriers after the parallel fanout", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-abort-barrier-"))
    const barrierEvents: Array<Extract<RunEvent, { kind: "barrier_reached" }>> = []

    try {
      await runWorkflow({
        controlHandler: async (request) => {
          if (request.kind !== "step_barrier") {
            throw new Error(`unexpected control request ${request.kind}`)
          }
          return { action: "continue", kind: "step_barrier" }
        },
        internals: {
          runActionStep: async (step) => ({
            exitCode: 0,
            providerEvents: [],
            result: step.id,
            stderr: "",
            stdout: String(step.id ?? ""),
            termination: "completed",
          }),
        },
        invocationInputs: {},
        onEvent: (event) => {
          if (event.kind === "barrier_reached") {
            barrierEvents.push(event)
          }
        },
        parentEnv: process.env,
        projectRoot: root,
        workflow: {
          id: "parallel-single-barrier",
          steps: [
            {
              branches: [
                {
                  id: "left",
                  steps: [
                    {
                      id: "left_first",
                      type: "shell",
                      with: {
                        command: "echo left-first",
                        result: "text",
                      },
                    },
                    {
                      id: "left_second",
                      type: "shell",
                      with: {
                        command: "echo left-second",
                        result: "text",
                      },
                    },
                  ],
                },
                {
                  id: "right",
                  steps: [
                    {
                      id: "right_first",
                      type: "shell",
                      with: {
                        command: "echo right-first",
                        result: "text",
                      },
                    },
                    {
                      id: "right_second",
                      type: "shell",
                      with: {
                        command: "echo right-second",
                        result: "text",
                      },
                    },
                  ],
                },
              ],
              id: "parallel",
              type: "parallel",
            },
          ],
        },
      })

      expect(barrierEvents).toHaveLength(1)
      expect(barrierEvents[0]?.barrier.next.map((node) => node.user_id)).toEqual(["left_first", "right_first"])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
