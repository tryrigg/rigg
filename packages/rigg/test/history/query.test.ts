import { afterEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"

import { findWorkspaceId } from "../../src/project/store"
import { closeDb, openDb } from "../../src/storage/db"
import {
  findLatestRun,
  getLogView,
  getRunByPrefix,
  getRunView,
  listHistory,
  listWorkflowSummaries,
  resolveLogView,
} from "../../src/history/query"
import { createRecorder } from "../../src/history/record"
import {
  cleanupTempDirs,
  createTempDir,
  nodeSnapshot,
  seedRecordedRun,
  withDataHome,
  writeWorkflow,
} from "../fixture/history"
import { runSnapshot } from "../fixture/builders"

const tempDirs: string[] = []

afterEach(async () => {
  await cleanupTempDirs(tempDirs)
})

describe("history/query", () => {
  test("recorder persists runs, steps, logs, and prefix lookup", async () => {
    const workspace = await createTempDir(tempDirs, "rigg-workspace-")
    const dataHome = await createTempDir(tempDirs, "rigg-data-")
    await writeWorkflow(workspace)
    const runId = await seedRecordedRun(workspace, dataHome)

    const openResult = await openDb({ env: { XDG_DATA_HOME: dataHome } })
    expect(openResult.kind).toBe("ok")
    if (openResult.kind !== "ok") {
      return
    }

    try {
      const workspaceId = findWorkspaceId(openResult.db, workspace)
      expect(workspaceId).not.toBeNull()
      const items = listHistory(openResult.db, {
        limit: 10,
        offset: 0,
        workspaceId: workspaceId!,
      })
      expect(items).toHaveLength(1)

      const prefix = getRunByPrefix(openResult.db, workspaceId!, "d3f8a1c")
      expect(prefix.kind).toBe("ok")

      const view = getRunView(openResult.db, runId)
      expect(items[0]?.startedAt).toBe("2026-03-14T00:00:00.000Z")
      expect(typeof items[0]?.startedAt).toBe("string")
      expect(view?.startedAt).toBe("2026-03-14T00:00:00.000Z")
      expect(view?.finishedAt).toBe("2026-03-24T05:32:05.000Z")
      expect(view?.steps[0]?.startedAt).toBe("2026-03-24T05:32:01.000Z")
      expect(view?.steps[0]?.finishedAt).toBe("2026-03-24T05:32:05.000Z")
      expect(view?.steps[0]?.userId).toBe("code-review")
      expect(view?.status).toBe("failed")

      const logs = getLogView(openResult.db, runId, "code-review")
      expect(logs?.runEntries).toEqual([])
      expect(logs?.steps[0]?.entries[0]?.text).toContain("Reviewing plan...")
    } finally {
      closeDb(openResult.db)
    }
  })

  test("log view keeps run-level events without node output", async () => {
    const workspace = await createTempDir(tempDirs, "rigg-workspace-")
    const dataHome = await createTempDir(tempDirs, "rigg-data-")
    await writeWorkflow(workspace)

    const runId = "8b6a2f41-54f0-4ed4-8d63-0d5f3df423af"
    await withDataHome(dataHome, async () => {
      const recorder = await createRecorder({
        workflowId: "plan",
        workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
      })
      recorder.emit({
        kind: "run_started",
        snapshot: runSnapshot({ run_id: runId, workflow_id: "plan" }),
      })
      recorder.emit({
        action: "continue",
        barrier_id: "bar-1",
        kind: "barrier_resolved",
        snapshot: runSnapshot({ run_id: runId, workflow_id: "plan" }),
      })
      recorder.emit({
        kind: "run_finished",
        snapshot: runSnapshot({
          finished_at: "2026-03-24T05:32:02.200Z",
          phase: "completed",
          reason: "completed",
          run_id: runId,
          status: "succeeded",
          workflow_id: "plan",
        }),
      })
      await recorder.close()
    })

    const openResult = await openDb({ env: { XDG_DATA_HOME: dataHome } })
    expect(openResult.kind).toBe("ok")
    if (openResult.kind !== "ok") {
      return
    }

    try {
      const logs = getLogView(openResult.db, runId)
      expect(logs?.runEntries).toEqual([expect.objectContaining({ kind: "event", text: "barrier resolved: continue" })])
      expect(logs?.steps).toEqual([])
    } finally {
      closeDb(openResult.db)
    }
  })

  test("step log view excludes run-level events", async () => {
    const workspace = await createTempDir(tempDirs, "rigg-workspace-")
    const dataHome = await createTempDir(tempDirs, "rigg-data-")
    await writeWorkflow(workspace)

    const runId = "a9a15303-59b5-4b70-a370-478fe92e4541"
    await withDataHome(dataHome, async () => {
      const recorder = await createRecorder({
        workflowId: "plan",
        workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
      })
      recorder.emit({
        kind: "run_started",
        snapshot: runSnapshot({ run_id: runId, workflow_id: "plan" }),
      })
      recorder.emit({
        action: "continue",
        barrier_id: "bar-1",
        kind: "barrier_resolved",
        snapshot: runSnapshot({ run_id: runId, workflow_id: "plan" }),
      })
      recorder.emit({
        chunk: "Reviewing plan...\n",
        kind: "step_output",
        node_path: "/0",
        stream: "stdout",
        user_id: "code-review",
      })

      const node = nodeSnapshot({
        duration_ms: 1000,
        finished_at: "2026-03-24T05:32:03.000Z",
        status: "succeeded",
        stdout: "Reviewing plan...\n",
        user_id: "code-review",
      })
      recorder.emit({
        kind: "node_completed",
        node,
        snapshot: runSnapshot({ nodes: [node], run_id: runId, workflow_id: "plan" }),
      })
      recorder.emit({
        kind: "run_finished",
        snapshot: runSnapshot({
          finished_at: "2026-03-24T05:32:04.000Z",
          nodes: [node],
          phase: "completed",
          reason: "completed",
          run_id: runId,
          status: "succeeded",
          workflow_id: "plan",
        }),
      })
      await recorder.close()
    })

    const openResult = await openDb({ env: { XDG_DATA_HOME: dataHome } })
    expect(openResult.kind).toBe("ok")
    if (openResult.kind !== "ok") {
      return
    }

    try {
      const all = getLogView(openResult.db, runId)
      expect(all?.runEntries).toEqual([expect.objectContaining({ kind: "event", text: "barrier resolved: continue" })])

      const step = getLogView(openResult.db, runId, "code-review")
      expect(step?.runEntries).toEqual([])
      expect(step?.steps[0]?.entries).toEqual([
        expect.objectContaining({ kind: "stream", stream: "stdout", text: "Reviewing plan...\n" }),
      ])
    } finally {
      closeDb(openResult.db)
    }
  })

  test("log view resolves node paths exactly and rejects ambiguous step ids", async () => {
    const workspace = await createTempDir(tempDirs, "rigg-workspace-")
    const dataHome = await createTempDir(tempDirs, "rigg-data-")
    await writeWorkflow(workspace)

    const runId = "91c078b7-1d5f-4d0a-8f30-d8c51f70db2d"
    await withDataHome(dataHome, async () => {
      const recorder = await createRecorder({
        workflowId: "plan",
        workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
      })
      recorder.emit({
        kind: "run_started",
        snapshot: runSnapshot({ run_id: runId, workflow_id: "plan" }),
      })

      const firstNode = nodeSnapshot({
        duration_ms: 1000,
        finished_at: "2026-03-24T05:32:02.000Z",
        status: "succeeded",
        user_id: "build",
      })
      const secondNode = nodeSnapshot({
        duration_ms: 1000,
        finished_at: "2026-03-24T05:32:03.000Z",
        node_path: "/1",
        status: "succeeded",
        stdout: "second",
        user_id: "build",
      })
      const anonNode = {
        ...nodeSnapshot({
          duration_ms: 1000,
          finished_at: "2026-03-24T05:32:04.000Z",
          node_path: "/2",
          status: "succeeded",
          stdout: "anon",
        }),
        user_id: null,
      }

      recorder.emit({ chunk: "first\n", kind: "step_output", node_path: "/0", stream: "stdout", user_id: "build" })
      recorder.emit({ chunk: "second\n", kind: "step_output", node_path: "/1", stream: "stdout", user_id: "build" })
      recorder.emit({ chunk: "anon\n", kind: "step_output", node_path: "/2", stream: "stdout", user_id: null })
      recorder.emit({
        kind: "node_completed",
        node: firstNode,
        snapshot: runSnapshot({ nodes: [firstNode], run_id: runId, workflow_id: "plan" }),
      })
      recorder.emit({
        kind: "node_completed",
        node: secondNode,
        snapshot: runSnapshot({ nodes: [firstNode, secondNode], run_id: runId, workflow_id: "plan" }),
      })
      recorder.emit({
        kind: "node_completed",
        node: anonNode,
        snapshot: runSnapshot({ nodes: [firstNode, secondNode, anonNode], run_id: runId, workflow_id: "plan" }),
      })
      recorder.emit({
        kind: "run_finished",
        snapshot: runSnapshot({
          finished_at: "2026-03-24T05:32:04.000Z",
          nodes: [firstNode, secondNode, anonNode],
          phase: "completed",
          reason: "completed",
          run_id: runId,
          status: "succeeded",
          workflow_id: "plan",
        }),
      })
      await recorder.close()
    })

    const openResult = await openDb({ env: { XDG_DATA_HOME: dataHome } })
    expect(openResult.kind).toBe("ok")
    if (openResult.kind !== "ok") {
      return
    }

    try {
      const byPath = resolveLogView(openResult.db, runId, "/2")
      expect(byPath).toMatchObject({
        kind: "ok",
        view: { steps: [expect.objectContaining({ nodePath: "/2", userId: null })] },
      })

      const ambiguous = resolveLogView(openResult.db, runId, "build")
      expect(ambiguous).toMatchObject({
        kind: "ambiguous_step",
        matches: [
          expect.objectContaining({ nodePath: "/0", userId: "build" }),
          expect.objectContaining({ nodePath: "/1", userId: "build" }),
        ],
      })
    } finally {
      closeDb(openResult.db)
    }
  })

  test("assigns copyable prefixes when recent run ids share the UUIDv7 timestamp bits", async () => {
    const workspace = await createTempDir(tempDirs, "rigg-workspace-")
    const dataHome = await createTempDir(tempDirs, "rigg-data-")
    await writeWorkflow(workspace)

    const runIds = ["018e4b7d-5a10-70bc-8000-000000000001", "018e4b7d-5a10-7abc-8000-000000000002"]

    await withDataHome(dataHome, async () => {
      for (const [index, runId] of runIds.entries()) {
        const recorder = await createRecorder({
          workflowId: "plan",
          workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
        })
        const startedAt = `2026-03-24T05:32:0${index + 1}.000Z`
        recorder.emit({
          kind: "run_started",
          snapshot: runSnapshot({ run_id: runId, started_at: startedAt, workflow_id: "plan" }),
        })
        recorder.emit({
          kind: "run_finished",
          snapshot: runSnapshot({
            finished_at: startedAt.replace(".000Z", ".500Z"),
            phase: "completed",
            reason: "completed",
            run_id: runId,
            started_at: startedAt,
            status: "succeeded",
            workflow_id: "plan",
          }),
        })
        await recorder.close()
      }
    })

    const openResult = await openDb({ env: { XDG_DATA_HOME: dataHome } })
    expect(openResult.kind).toBe("ok")
    if (openResult.kind !== "ok") {
      return
    }

    try {
      const workspaceId = findWorkspaceId(openResult.db, workspace)
      expect(workspaceId).not.toBeNull()

      const items = listHistory(openResult.db, { limit: 10, offset: 0, workspaceId: workspaceId! })
      expect(items.map((item) => item.shortId)).toEqual(["018e4b7d5a107a", "018e4b7d5a1070"])

      const prefix = getRunByPrefix(openResult.db, workspaceId!, "018e4b7d5a10")
      expect(prefix).toEqual({
        kind: "ambiguous",
        matches: [
          expect.objectContaining({ runId: runIds[1], shortId: "018e4b7d5a107a" }),
          expect.objectContaining({ runId: runIds[0], shortId: "018e4b7d5a1070" }),
        ],
      })
    } finally {
      closeDb(openResult.db)
    }
  })

  test("keeps short ids unique across the whole project, not just the current page", async () => {
    const workspace = await createTempDir(tempDirs, "rigg-workspace-")
    const dataHome = await createTempDir(tempDirs, "rigg-data-")
    await writeWorkflow(workspace)

    const firstRunId = "018e4b7d-5a10-7000-8000-000000000001"
    const secondRunId = "018e4b7d-5a10-7001-8000-000000000002"
    const thirdRunId = "018e4b7d-5a10-7abc-8000-000000000003"
    const runIds = [firstRunId, secondRunId, thirdRunId]

    await withDataHome(dataHome, async () => {
      for (const [index, runId] of runIds.entries()) {
        const recorder = await createRecorder({
          workflowId: "plan",
          workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
        })
        const startedAt = `2026-03-24T05:32:0${index + 1}.000Z`
        recorder.emit({
          kind: "run_started",
          snapshot: runSnapshot({ run_id: runId, started_at: startedAt, workflow_id: "plan" }),
        })
        recorder.emit({
          kind: "run_finished",
          snapshot: runSnapshot({
            finished_at: startedAt.replace(".000Z", ".500Z"),
            phase: "completed",
            reason: "completed",
            run_id: runId,
            started_at: startedAt,
            status: "succeeded",
            workflow_id: "plan",
          }),
        })
        await recorder.close()
      }
    })

    const openResult = await openDb({ env: { XDG_DATA_HOME: dataHome } })
    expect(openResult.kind).toBe("ok")
    if (openResult.kind !== "ok") {
      return
    }

    try {
      const workspaceId = findWorkspaceId(openResult.db, workspace)
      expect(workspaceId).not.toBeNull()

      const items = listHistory(openResult.db, { limit: 1, offset: 1, workspaceId: workspaceId! })
      expect(items).toHaveLength(1)
      expect(items[0]?.runId).toBe(secondRunId)
      expect(items[0]?.shortId).toBe("018e4b7d5a107001")

      const view = getRunView(openResult.db, secondRunId)
      expect(view?.shortId).toBe("018e4b7d5a107001")

      const prefix = getRunByPrefix(openResult.db, workspaceId!, items[0]!.shortId)
      expect(prefix).toEqual({ kind: "ok", runId: secondRunId })
    } finally {
      closeDb(openResult.db)
    }
  })

  test("latest run queries stay stable when started_at timestamps tie", async () => {
    const workspace = await createTempDir(tempDirs, "rigg-workspace-")
    const dataHome = await createTempDir(tempDirs, "rigg-data-")
    await writeWorkflow(workspace)

    const startedAt = "2026-03-24T05:32:01.000Z"
    const olderRunId = "018e4b7d-5a10-7000-8000-000000000001"
    const newerRunId = "018e4b7d-5a10-7000-8000-00000000000f"
    const runIds = [olderRunId, newerRunId]

    await withDataHome(dataHome, async () => {
      for (const runId of runIds) {
        const recorder = await createRecorder({
          workflowId: "plan",
          workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
        })
        recorder.emit({
          kind: "run_started",
          snapshot: runSnapshot({ run_id: runId, started_at: startedAt, workflow_id: "plan" }),
        })
        recorder.emit({
          kind: "run_finished",
          snapshot: runSnapshot({
            finished_at: "2026-03-24T05:32:02.000Z",
            phase: "completed",
            reason: "completed",
            run_id: runId,
            started_at: startedAt,
            status: "succeeded",
            workflow_id: "plan",
          }),
        })
        await recorder.close()
      }
    })

    const openResult = await openDb({ env: { XDG_DATA_HOME: dataHome } })
    expect(openResult.kind).toBe("ok")
    if (openResult.kind !== "ok") {
      return
    }

    try {
      const workspaceId = findWorkspaceId(openResult.db, workspace)
      expect(workspaceId).not.toBeNull()

      const items = listHistory(openResult.db, { limit: 2, offset: 0, workspaceId: workspaceId! })
      expect(items.map((item) => item.runId)).toEqual([newerRunId, olderRunId])
      expect(findLatestRun(openResult.db, workspaceId!)).toMatchObject({ runId: newerRunId })
    } finally {
      closeDb(openResult.db)
    }
  })

  test("workflow summaries return the latest run for every workflow", async () => {
    const workspace = await createTempDir(tempDirs, "rigg-workspace-")
    const dataHome = await createTempDir(tempDirs, "rigg-data-")
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await Bun.write(
      join(workspace, ".rigg", "plan.yaml"),
      "id: plan\nsteps:\n  - type: shell\n    with:\n      command: echo hi\n",
    )
    await Bun.write(
      join(workspace, ".rigg", "review.yaml"),
      "id: review\nsteps:\n  - type: shell\n    with:\n      command: echo hi\n",
    )

    await withDataHome(dataHome, async () => {
      const reviewRecorder = await createRecorder({
        workflowId: "review",
        workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
      })
      reviewRecorder.emit({
        kind: "run_started",
        snapshot: runSnapshot({
          run_id: "10000000-0000-4000-8000-000000000001",
          started_at: "2026-03-24T05:00:00.000Z",
          workflow_id: "review",
        }),
      })
      reviewRecorder.emit({
        kind: "run_finished",
        snapshot: runSnapshot({
          finished_at: "2026-03-24T05:00:01.000Z",
          phase: "completed",
          reason: "completed",
          run_id: "10000000-0000-4000-8000-000000000001",
          started_at: "2026-03-24T05:00:00.000Z",
          status: "succeeded",
          workflow_id: "review",
        }),
      })
      await reviewRecorder.close()

      for (let i = 0; i < 1001; i += 1) {
        const n = String(i + 2).padStart(12, "0")
        const startedAt = `2026-03-24T05:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`
        const recorder = await createRecorder({
          workflowId: "plan",
          workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
        })
        recorder.emit({
          kind: "run_started",
          snapshot: runSnapshot({
            run_id: `20000000-0000-4000-8000-${n}`,
            started_at: startedAt,
            workflow_id: "plan",
          }),
        })
        recorder.emit({
          kind: "run_finished",
          snapshot: runSnapshot({
            finished_at: startedAt.replace(".000Z", ".500Z"),
            phase: "completed",
            reason: "completed",
            run_id: `20000000-0000-4000-8000-${n}`,
            started_at: startedAt,
            status: "succeeded",
            workflow_id: "plan",
          }),
        })
        await recorder.close()
      }
    })

    const openResult = await openDb({ env: { XDG_DATA_HOME: dataHome } })
    expect(openResult.kind).toBe("ok")
    if (openResult.kind !== "ok") {
      return
    }

    try {
      const workspaceId = findWorkspaceId(openResult.db, workspace)
      expect(workspaceId).not.toBeNull()
      const summaries = listWorkflowSummaries(openResult.db, workspaceId!)
      expect(summaries).toHaveLength(2)
      expect(summaries.find((item) => item.workflowId === "review")?.lastRun?.status).toBe("succeeded")
      expect(summaries.find((item) => item.workflowId === "plan")?.lastRun?.runId).toBe(
        "20000000-0000-4000-8000-000000001002",
      )
    } finally {
      closeDb(openResult.db)
    }
  })

  test("matches a full normalized run id without scanning prefix expressions", async () => {
    const workspace = await createTempDir(tempDirs, "rigg-workspace-")
    const dataHome = await createTempDir(tempDirs, "rigg-data-")
    await writeWorkflow(workspace)

    const runId = "018e4b7d-5a10-7abc-8000-000000000003"

    await withDataHome(dataHome, async () => {
      const recorder = await createRecorder({
        workflowId: "plan",
        workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
      })
      recorder.emit({
        kind: "run_started",
        snapshot: runSnapshot({ run_id: runId, started_at: "2026-03-24T05:32:01.000Z", workflow_id: "plan" }),
      })
      recorder.emit({
        kind: "run_finished",
        snapshot: runSnapshot({
          finished_at: "2026-03-24T05:32:02.000Z",
          phase: "completed",
          reason: "completed",
          run_id: runId,
          started_at: "2026-03-24T05:32:01.000Z",
          status: "succeeded",
          workflow_id: "plan",
        }),
      })
      await recorder.close()
    })

    const openResult = await openDb({ env: { XDG_DATA_HOME: dataHome } })
    expect(openResult.kind).toBe("ok")
    if (openResult.kind !== "ok") {
      return
    }

    try {
      const workspaceId = findWorkspaceId(openResult.db, workspace)
      expect(workspaceId).not.toBeNull()

      expect(getRunByPrefix(openResult.db, workspaceId!, "018e4b7d5a107abc8000000000000003")).toEqual({
        kind: "ok",
        runId,
      })
    } finally {
      closeDb(openResult.db)
    }
  })
})
