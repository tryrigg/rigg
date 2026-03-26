import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { join } from "node:path"

import { eq } from "drizzle-orm"

import { getRunView, listHistory } from "../../src/history/query"
import { createRecorder } from "../../src/history/record"
import { eventTable, runTable, stepTable } from "../../src/history/history.sql"
import { findWorkspaceId } from "../../src/project/store"
import { closeDb, openDb } from "../../src/storage/db"
import { cleanupTempDirs, createTempDir, nodeSnapshot, withDataHome, writeWorkflow } from "../fixture/history"
import { runSnapshot } from "../fixture/builders"

const tempDirs: string[] = []

afterEach(async () => {
  await cleanupTempDirs(tempDirs)
})

async function withWriteFailure(match: (sql: string, args: unknown[]) => boolean, run: () => Promise<void>) {
  const origPrepare = Database.prototype.prepare as any
  Database.prototype.prepare = function (sqlText, ...params: unknown[]) {
    const stmt = origPrepare.call(this, sqlText, ...params)
    if (typeof sqlText !== "string" || typeof stmt.run !== "function") {
      return stmt
    }

    const origRun = stmt.run
    stmt.run = function (...args: unknown[]) {
      if (match(sqlText, args)) {
        throw new Error("database is locked")
      }
      return origRun.call(this, ...args)
    }
    return stmt
  }

  try {
    await run()
  } finally {
    Database.prototype.prepare = origPrepare
  }
}

describe("history/record", () => {
  test("preserves completion events when the queue overflows", async () => {
    const workspace = await createTempDir(tempDirs, "rigg-workspace-")
    const dataHome = await createTempDir(tempDirs, "rigg-data-")
    await writeWorkflow(workspace)
    const runId = "e4f9b2d5-0a3c-4f8a-9c2d-4a6f8b0c1d2e"

    await withDataHome(dataHome, async () => {
      const recorder = await createRecorder({
        workflowId: "plan",
        workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
      })
      recorder.emit({
        kind: "run_started",
        snapshot: runSnapshot({ run_id: runId, workflow_id: "plan" }),
      })
      for (let i = 0; i < 2050; i += 1) {
        recorder.emit({
          chunk: `line-${i}\n`,
          kind: "step_output",
          node_path: "/0",
          stream: "stdout",
          user_id: "code-review",
        })
      }
      const node = nodeSnapshot({
        duration_ms: 3900,
        finished_at: "2026-03-24T05:32:05.000Z",
        status: "succeeded",
        stdout: "done",
      })
      recorder.emit({
        kind: "node_completed",
        node,
        snapshot: runSnapshot({ nodes: [node], run_id: runId, workflow_id: "plan" }),
      })
      recorder.emit({
        kind: "run_finished",
        snapshot: runSnapshot({
          finished_at: "2026-03-24T05:32:05.000Z",
          nodes: [node],
          phase: "completed",
          reason: "completed",
          run_id: runId,
          status: "succeeded",
          workflow_id: "plan",
        }),
      })

      const result = await recorder.close()
      expect(result.recording_status).toBe("complete")
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
      expect(items[0]?.status).toBe("succeeded")

      const runRow = openResult.db.select().from(runTable).where(eq(runTable.id, runId)).get()
      const stepRow = openResult.db.select().from(stepTable).where(eq(stepTable.runId, runId)).get()
      const eventRow = openResult.db.select().from(eventTable).where(eq(eventTable.runId, runId)).get()
      expect(typeof runRow?.createdAt).toBe("number")
      expect(typeof runRow?.updatedAt).toBe("number")
      expect(typeof runRow?.startedAt).toBe("number")
      expect(typeof runRow?.finishedAt).toBe("number")
      expect(typeof stepRow?.createdAt).toBe("number")
      expect(typeof stepRow?.updatedAt).toBe("number")
      expect(typeof stepRow?.startedAt).toBe("number")
      expect(typeof stepRow?.finishedAt).toBe("number")
      expect(typeof eventRow?.createdAt).toBe("number")
      expect(typeof eventRow?.updatedAt).toBe("number")

      const view = getRunView(openResult.db, runId)
      expect(view?.startedAt).toBe("2026-03-14T00:00:00.000Z")
      expect(view?.finishedAt).toBe("2026-03-24T05:32:05.000Z")
      expect(view?.steps[0]?.startedAt).toBe("2026-03-24T05:32:01.000Z")
      expect(view?.steps[0]?.finishedAt).toBe("2026-03-24T05:32:05.000Z")
      expect(view?.steps[0]?.status).toBe("succeeded")
    } finally {
      closeDb(openResult.db)
    }
  })

  test("later writes bump run and step updated_at", async () => {
    const workspace = await createTempDir(tempDirs, "rigg-workspace-")
    const dataHome = await createTempDir(tempDirs, "rigg-data-")
    await writeWorkflow(workspace)

    const runId = "8c2a6d90-f21e-4e72-bc61-28d0880f6390"
    let runUpdatedAtBefore = 0
    let stepUpdatedAtBefore = 0

    await withDataHome(dataHome, async () => {
      const recorder = await createRecorder({
        workflowId: "plan",
        workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
      })
      const startedNode = nodeSnapshot({ started_at: "2026-03-24T05:32:01.500Z" })

      recorder.emit({
        kind: "run_started",
        snapshot: runSnapshot({ run_id: runId, started_at: "2026-03-24T05:32:01.000Z", workflow_id: "plan" }),
      })
      recorder.emit({
        kind: "node_started",
        node: startedNode,
        snapshot: runSnapshot({ nodes: [startedNode], run_id: runId, workflow_id: "plan" }),
      })

      await Bun.sleep(80)

      const readBefore = await openDb({ env: { XDG_DATA_HOME: dataHome } })
      expect(readBefore.kind).toBe("ok")
      if (readBefore.kind === "ok") {
        try {
          runUpdatedAtBefore = readBefore.db.select().from(runTable).where(eq(runTable.id, runId)).get()?.updatedAt ?? 0
          stepUpdatedAtBefore =
            readBefore.db.select().from(stepTable).where(eq(stepTable.runId, runId)).get()?.updatedAt ?? 0
        } finally {
          closeDb(readBefore.db)
        }
      }

      await Bun.sleep(5)

      const finishedNode = nodeSnapshot({
        duration_ms: 3500,
        finished_at: "2026-03-24T05:32:05.000Z",
        started_at: "2026-03-24T05:32:01.500Z",
        status: "succeeded",
        stdout: "done",
      })
      recorder.emit({
        kind: "node_completed",
        node: finishedNode,
        snapshot: runSnapshot({ nodes: [finishedNode], run_id: runId, workflow_id: "plan" }),
      })
      recorder.emit({
        kind: "run_finished",
        snapshot: runSnapshot({
          finished_at: "2026-03-24T05:32:05.000Z",
          nodes: [finishedNode],
          phase: "completed",
          reason: "completed",
          run_id: runId,
          started_at: "2026-03-24T05:32:01.000Z",
          status: "succeeded",
          workflow_id: "plan",
        }),
      })

      const result = await recorder.close()
      expect(result.recording_status).toBe("complete")
    })

    const openResult = await openDb({ env: { XDG_DATA_HOME: dataHome } })
    expect(openResult.kind).toBe("ok")
    if (openResult.kind !== "ok") {
      return
    }

    try {
      const runRow = openResult.db.select().from(runTable).where(eq(runTable.id, runId)).get()
      const stepRow = openResult.db.select().from(stepTable).where(eq(stepTable.runId, runId)).get()

      expect(runRow?.updatedAt).toBeGreaterThan(runUpdatedAtBefore)
      expect(stepRow?.updatedAt).toBeGreaterThan(stepUpdatedAtBefore)

      const view = getRunView(openResult.db, runId)
      expect(view?.startedAt).toBe("2026-03-24T05:32:01.000Z")
      expect(view?.finishedAt).toBe("2026-03-24T05:32:05.000Z")
      expect(view?.steps[0]?.startedAt).toBe("2026-03-24T05:32:01.500Z")
      expect(view?.steps[0]?.finishedAt).toBe("2026-03-24T05:32:05.000Z")
    } finally {
      closeDb(openResult.db)
    }
  })

  test("marks an already-persisted run partial after a later write failure", async () => {
    const workspace = await createTempDir(tempDirs, "rigg-workspace-")
    const dataHome = await createTempDir(tempDirs, "rigg-data-")
    await writeWorkflow(workspace)

    const runId = "b7c2e5f8-3d6a-4b1c-9f5a-7d9e1f3b5c7d"
    await withDataHome(dataHome, async () => {
      const recorder = await createRecorder({
        workflowId: "plan",
        workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
      })
      recorder.emit({
        kind: "run_started",
        snapshot: runSnapshot({ run_id: runId, workflow_id: "plan" }),
      })
      await Bun.sleep(80)

      await withWriteFailure(
        (sqlText, args) => sqlText.startsWith('insert into "run"') && args[0] === runId && args.includes("succeeded"),
        async () => {
          recorder.emit({
            kind: "run_finished",
            snapshot: runSnapshot({
              finished_at: "2026-03-24T05:32:05.000Z",
              phase: "completed",
              reason: "completed",
              run_id: runId,
              status: "succeeded",
              workflow_id: "plan",
            }),
          })

          const result = await recorder.close()
          expect(result.recording_status).toBe("partial")
        },
      )
    })

    const openResult = await openDb({ env: { XDG_DATA_HOME: dataHome } })
    expect(openResult.kind).toBe("ok")
    if (openResult.kind !== "ok") {
      return
    }

    try {
      const view = getRunView(openResult.db, runId)
      expect(view?.status).toBe("running")
      expect(view?.recordingStatus).toBe("partial")
    } finally {
      closeDb(openResult.db)
    }
  })

  test("keeps the run unrecorded when the first write fails", async () => {
    const workspace = await createTempDir(tempDirs, "rigg-workspace-")
    const dataHome = await createTempDir(tempDirs, "rigg-data-")
    await writeWorkflow(workspace)

    const runId = "7e3a1b92-4c5d-4d3a-8b6e-1a9f4d2c7b8e"
    await withDataHome(dataHome, async () => {
      const recorder = await createRecorder({
        workflowId: "plan",
        workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
      })

      await withWriteFailure(
        (sqlText, args) => sqlText.startsWith('insert into "run"') && args[0] === runId,
        async () => {
          recorder.emit({
            kind: "run_started",
            snapshot: runSnapshot({ run_id: runId, workflow_id: "plan" }),
          })

          const result = await recorder.close()
          expect(result.recording_status).toBe("disabled")
          expect(result.warnings).toEqual([
            "⚠ Run history unavailable: database is locked",
            "  Runs will still execute but this run will not be recorded.",
          ])
        },
      )
    })

    const openResult = await openDb({ env: { XDG_DATA_HOME: dataHome } })
    expect(openResult.kind).toBe("ok")
    if (openResult.kind !== "ok") {
      return
    }

    try {
      expect(getRunView(openResult.db, runId)).toBeNull()
    } finally {
      closeDb(openResult.db)
    }
  })
})
