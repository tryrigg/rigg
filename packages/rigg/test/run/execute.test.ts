import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import type { WorkflowDocument } from "../../src/compile/schema"
import { executeWorkflow } from "../../src/run/execute"

async function readPersistedState(projectRoot: string): Promise<{
  nodes: Array<{
    result: unknown
    status: string
    stdout_path: string | null
    user_id: string | null
  }>
  status: string
}> {
  const runIds = (await readdir(join(projectRoot, ".rigg", "runs"))).filter((entry) => !entry.startsWith(".tmp-"))
  const runId = runIds[0]
  if (runId === undefined) {
    throw new Error("expected a persisted run directory")
  }

  const state = await readFile(join(projectRoot, ".rigg", "runs", runId, "state.json"), "utf8")
  return JSON.parse(state) as {
    nodes: Array<{
      result: unknown
      status: string
      stdout_path: string | null
      user_id: string | null
    }>
    status: string
  }
}

describe("run/execute", () => {
  test("uses project root as the execution cwd and write_file base path", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-"))
    const nested = join(root, "nested")
    await mkdir(nested, { recursive: true })

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
        configFiles: [],
        cwd: nested,
        invocationInputs: {},
        parentEnv: process.env,
        projectRoot: root,
        toolVersion: "0.0.0",
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
        configFiles: [],
        cwd: root,
        invocationInputs: {},
        parentEnv: process.env,
        projectRoot: root,
        toolVersion: "0.0.0",
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
        configFiles: [],
        cwd: root,
        invocationInputs: {},
        parentEnv: process.env,
        projectRoot: root,
        toolVersion: "0.0.0",
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

  test("waits for sibling parallel branches before surfacing a thrown branch error", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-parallel-"))

    try {
      await expect(
        executeWorkflow({
          configFiles: [],
          cwd: root,
          internals: {
            runActionStep: async (step) => {
              if (step.id === "slow") {
                await new Promise((resolve) => setTimeout(resolve, 100))
                return {
                  exitCode: 0,
                  providerEvents: [],
                  result: "finished",
                  stderr: "",
                  stdout: "finished",
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
          parentEnv: process.env,
          projectRoot: root,
          toolVersion: "0.0.0",
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

      const persisted = await readPersistedState(root)
      expect(persisted.status).toBe("failed")
      expect(persisted.nodes.find((node) => node.user_id === "slow")).toMatchObject({
        result: "finished",
        status: "succeeded",
      })
      expect(persisted.nodes.find((node) => node.user_id === "boom")?.status).toBe("failed")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("evaluates loop exports with the current iteration run context", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-loop-exports-"))

    try {
      const snapshot = await executeWorkflow({
        configFiles: [],
        cwd: root,
        internals: {
          runActionStep: async () => ({
            exitCode: 0,
            providerEvents: [],
            result: "ok",
            stderr: "",
            stdout: "ok",
          }),
        },
        invocationInputs: {},
        parentEnv: process.env,
        projectRoot: root,
        toolVersion: "0.0.0",
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

  test("emits only a failed loop iteration event when loop exports fail", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-loop-events-"))
    const outcomes: string[] = []

    try {
      await expect(
        executeWorkflow({
          configFiles: [],
          cwd: root,
          internals: {
            runActionStep: async () => ({
              exitCode: 0,
              providerEvents: [],
              result: "ok",
              stderr: "",
              stdout: "ok",
            }),
          },
          invocationInputs: {},
          onProgress: (event) => {
            if (event.kind === "loop_iteration_finished") {
              outcomes.push(event.outcome)
            }
          },
          parentEnv: process.env,
          projectRoot: root,
          toolVersion: "0.0.0",
          workflow: {
            id: "loop-export-failure",
            steps: [
              {
                exports: {
                  invalid: "${{ missing() }}",
                },
                id: "retry",
                max: 2,
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
        }),
      ).rejects.toThrow("unsupported function `missing`")

      expect(outcomes).toEqual(["failed"])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("records provider-only logs in node metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-execute-provider-logs-"))

    try {
      const snapshot = await executeWorkflow({
        configFiles: [],
        cwd: root,
        internals: {
          runActionStep: async () => ({
            exitCode: 0,
            providerEvents: [{ kind: "status", message: "thread started thread_123", provider: "codex" as const }],
            result: "ok",
            stderr: "",
            stdout: "",
          }),
        },
        invocationInputs: {},
        parentEnv: process.env,
        projectRoot: root,
        toolVersion: "0.0.0",
        workflow: {
          id: "provider-logs",
          steps: [
            {
              id: "agent",
              type: "codex",
              with: {
                action: "exec",
                prompt: "Say hi",
              },
            },
          ],
        },
      })

      const node = snapshot.nodes.find((entry) => entry.user_id === "agent")
      expect(node?.stdout_path).toBeString()
      expect(node?.stdout_path).not.toBeNull()
      expect(await readFile(join(root, ".rigg", "runs", snapshot.run_id, node?.stdout_path ?? ""), "utf8")).toContain(
        "thread started thread_123",
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
