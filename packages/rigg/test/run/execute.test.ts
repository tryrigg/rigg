import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import type { WorkflowDocument } from "../../src/compile/schema"
import { StepInterruptedError } from "../../src/run/error"
import type { RunEvent } from "../../src/run/progress"
import { executeWorkflow } from "../../src/run/execute"
import { installFakeCodex } from "../fixture/fake-codex"

describe("run/execute", () => {
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

      const snapshot = await executeWorkflow({
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
      const snapshot = await executeWorkflow({
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
      return executeWorkflow({
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

  test("interrupts sibling parallel branches after a thrown branch error", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-parallel-"))
    const nodeStatuses = new Map<string, string>()

    try {
      await expect(
        executeWorkflow({
          internals: {
            runActionStep: async (step, _context, options) => {
              if (step.id === "slow") {
                await new Promise((resolve, reject) => {
                  const timer = setTimeout(resolve, 100)
                  const onAbort = () => {
                    clearTimeout(timer)
                    reject(new StepInterruptedError("slow branch interrupted"))
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

  test("evaluates loop exports with the current iteration run context", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-loop-exports-"))

    try {
      const snapshot = await executeWorkflow({
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

  test("pauses at step barriers and continues in order", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-barrier-"))
    const barriers: Array<{ next: string[]; reason: string }> = []

    try {
      const snapshot = await executeWorkflow({
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

  test("surfaces parallel frontiers as a single barrier", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-parallel-barrier-"))
    const barrierNext: string[][] = []

    try {
      await executeWorkflow({
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
                  ],
                },
              ],
            },
          ],
        },
      })

      expect(barrierNext[0]).toEqual(["left_step", "right_step"])
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

      const snapshot = await executeWorkflow({
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
        turnStarts: [
          {
            steps: [
              {
                kind: "request",
                method: "item/tool/requestUserInput",
                params: {
                  threadId: "__THREAD_ID__",
                  turnId: "__TURN_ID__",
                  itemId: "input_left",
                  questions: [
                    {
                      id: "left",
                      header: "Left",
                      question: "Answer left",
                      isOther: false,
                      isSecret: false,
                    },
                  ],
                },
                expectResult: {
                  answers: {
                    left: {
                      answers: ["L"],
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
                    id: "msg_left",
                    text: "left done",
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
          {
            steps: [
              {
                kind: "request",
                method: "item/tool/requestUserInput",
                params: {
                  threadId: "__THREAD_ID__",
                  turnId: "__TURN_ID__",
                  itemId: "input_right",
                  questions: [
                    {
                      id: "right",
                      header: "Right",
                      question: "Answer right",
                      isOther: false,
                      isSecret: false,
                    },
                  ],
                },
                expectResult: {
                  answers: {
                    right: {
                      answers: ["R"],
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
                    id: "msg_right",
                    text: "right done",
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
        ],
      })

      const snapshot = await executeWorkflow({
        controlHandler: async (request) => {
          if (request.kind === "step_barrier") {
            return { action: "continue", kind: "step_barrier" }
          }
          interactions.push(`${request.interaction.user_id}:${request.interaction.kind}`)
          if (request.interaction.kind !== "user_input") {
            throw new Error(`unexpected interaction ${request.interaction.kind}`)
          }
          return request.interaction.user_id === "left_agent"
            ? { answers: { left: { answers: ["L"] } }, kind: "user_input" }
            : { answers: { right: { answers: ["R"] } }, kind: "user_input" }
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
        turnStarts: [
          {
            steps: [],
          },
          {
            steps: [
              {
                kind: "notification",
                method: "turn/completed",
                params: {
                  threadId: "__THREAD_ID__",
                  turn: {
                    id: "__TURN_ID__",
                    items: [],
                    status: "failed",
                    error: { message: "boom" },
                  },
                },
              },
            ],
          },
        ],
      })

      const snapshot = await executeWorkflow({
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

      expect(snapshot.status).toBe("failed")
      expect(snapshot.nodes.find((node) => node.user_id === "right_agent")?.status).toBe("failed")
      expect(snapshot.nodes.find((node) => node.user_id === "left_agent")?.status).toBe("interrupted")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("includes codex preview data in step barriers", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-barrier-preview-"))
    const barriers: RunEvent[] = []

    try {
      await executeWorkflow({
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
              id: "review",
              type: "codex",
              with: {
                action: "run",
                model: "gpt-5.4",
                prompt: "Review branch ${{ inputs.branch }}",
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
})
