import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readlink, realpath, symlink } from "node:fs/promises"
import { join } from "node:path"

import { eq } from "drizzle-orm"

import { createRecorder } from "../../src/history/record"
import { projectTable } from "../../src/project/project.sql"
import { ensureWorkspace, findProjectId, findWorkspaceId } from "../../src/project/store"
import { workspaceTable } from "../../src/project/workspace.sql"
import { closeDb, openDb } from "../../src/storage/db"
import { cleanupTempDirs, createTempDir, runProjectWorker, withDataHome, writeWorkflow } from "../fixture/history"
import { runSnapshot } from "../fixture/builders"

const tempDirs: string[] = []

afterEach(async () => {
  await cleanupTempDirs(tempDirs)
})

describe("project/store", () => {
  test("lookup uses canonical workspace paths", async () => {
    const workspace = await createTempDir(tempDirs, "rigg-workspace-")
    const dataHome = await createTempDir(tempDirs, "rigg-data-")
    const linkRoot = await createTempDir(tempDirs, "rigg-link-root-")
    const alias = join(linkRoot, "workspace-link")
    const root = await realpath(workspace)
    await writeWorkflow(workspace)
    await symlink(workspace, alias)
    expect(await readlink(alias)).toBe(workspace)

    await withDataHome(dataHome, async () => {
      const recorder = await createRecorder({
        workflowId: "plan",
        workspace: { riggDir: join(alias, ".rigg"), rootDir: alias },
      })
      recorder.emit({
        kind: "run_started",
        snapshot: runSnapshot({ run_id: "4c5272ae-e62c-4751-b4ae-282ef8e0e1dd", workflow_id: "plan" }),
      })
      recorder.emit({
        kind: "run_finished",
        snapshot: runSnapshot({
          finished_at: "2026-03-24T05:32:02.200Z",
          phase: "completed",
          reason: "completed",
          run_id: "4c5272ae-e62c-4751-b4ae-282ef8e0e1dd",
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
      const projects = openResult.db.select().from(projectTable).all()
      const workspaces = openResult.db.select().from(workspaceTable).all()
      expect(projects).toHaveLength(1)
      expect(projects[0]?.id).toBe(`path:${root}`)
      expect(typeof projects[0]?.createdAt).toBe("number")
      expect(typeof projects[0]?.updatedAt).toBe("number")
      expect(workspaces).toHaveLength(1)
      expect(typeof workspaces[0]?.createdAt).toBe("number")
      expect(typeof workspaces[0]?.updatedAt).toBe("number")
      expect(workspaces[0]?.rootDir).toBe(root)
      expect(workspaces[0]?.riggDir).toBe(join(root, ".rigg"))
      expect(workspaces[0]?.projectId).toBe(projects[0]?.id)
      expect(findProjectId(openResult.db, workspace)).toBe(projects[0]?.id ?? null)
      expect(findProjectId(openResult.db, alias)).toBe(projects[0]?.id ?? null)
      expect(findWorkspaceId(openResult.db, workspace)).toBe(workspaces[0]?.id ?? null)
      expect(findWorkspaceId(openResult.db, alias)).toBe(workspaces[0]?.id ?? null)
    } finally {
      closeDb(openResult.db)
    }
  })

  test("re-upserting a workspace preserves created_at and bumps updated_at", async () => {
    const workspace = await createTempDir(tempDirs, "rigg-workspace-")
    const dataHome = await createTempDir(tempDirs, "rigg-data-")
    await writeWorkflow(workspace)

    const openResult = await openDb({ env: { XDG_DATA_HOME: dataHome } })
    expect(openResult.kind).toBe("ok")
    if (openResult.kind !== "ok") {
      return
    }

    try {
      const first = ensureWorkspace(openResult.db, { riggDir: join(workspace, ".rigg"), rootDir: workspace })
      const before = openResult.db.select().from(workspaceTable).where(eq(workspaceTable.id, first.workspaceId)).get()
      expect(before).toBeDefined()

      await Bun.sleep(5)

      const second = ensureWorkspace(openResult.db, { riggDir: join(workspace, ".rigg"), rootDir: workspace })
      const after = openResult.db.select().from(workspaceTable).where(eq(workspaceTable.id, second.workspaceId)).get()

      expect(second).toEqual(first)
      expect(after).toBeDefined()
      expect(after?.createdAt).toBe(before?.createdAt)
      expect(after?.updatedAt).toBeGreaterThan(before?.updatedAt ?? 0)
    } finally {
      closeDb(openResult.db)
    }
  })

  test("concurrent same-workspace opens reuse one workspace row", async () => {
    const workspace = await createTempDir(tempDirs, "rigg-workspace-")
    const dataHome = await createTempDir(tempDirs, "rigg-data-")
    const root = await realpath(workspace)
    await writeWorkflow(workspace)

    const setup = await openDb({ env: { XDG_DATA_HOME: dataHome } })
    expect(setup.kind).toBe("ok")
    if (setup.kind !== "ok") {
      return
    }
    closeDb(setup.db)

    const gate = join(dataHome, "start")
    const pending = [
      runProjectWorker({
        dataHome,
        gate,
        workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
      }),
      runProjectWorker({
        dataHome,
        gate,
        workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
      }),
    ]

    await Bun.sleep(50)
    await Bun.write(gate, "")

    const results = await Promise.all(pending)
    expect(results).toEqual([expect.objectContaining({ kind: "ok" }), expect.objectContaining({ kind: "ok" })])
    expect(results[0]).toEqual(results[1])

    const readResult = await openDb({ env: { XDG_DATA_HOME: dataHome } })
    expect(readResult.kind).toBe("ok")
    if (readResult.kind !== "ok") {
      return
    }

    try {
      const projects = readResult.db.select().from(projectTable).all()
      const workspaces = readResult.db.select().from(workspaceTable).all()
      expect(projects).toHaveLength(1)
      expect(projects[0]?.id).toBe(`path:${root}`)
      expect(workspaces).toHaveLength(1)
      expect(workspaces[0]?.rootDir).toBe(root)
      expect(workspaces[0]?.projectId).toBe(projects[0]?.id)
    } finally {
      closeDb(readResult.db)
    }
  })

  test("git worktrees share one project row and keep separate workspace rows", async () => {
    const main = await createTempDir(tempDirs, "rigg-main-")
    const worktree = await createTempDir(tempDirs, "rigg-worktree-")
    const dataHome = await createTempDir(tempDirs, "rigg-data-")
    await writeWorkflow(main)
    await writeWorkflow(worktree)
    await mkdir(join(main, ".git", "worktrees", "feature"), { recursive: true })
    await Bun.write(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "feature")}\n`)

    await withDataHome(dataHome, async () => {
      const runIds = ["e684c0fd-d951-4b31-84f8-ea22c06d1e78", "cf4f57b5-46f5-4e6a-8ef0-307f46fe3c77"]
      for (const [index, rootDir] of [main, worktree].entries()) {
        const recorder = await createRecorder({
          workflowId: "plan",
          workspace: { riggDir: join(rootDir, ".rigg"), rootDir },
        })
        recorder.emit({
          kind: "run_started",
          snapshot: runSnapshot({ run_id: runIds[index]!, workflow_id: "plan" }),
        })
        recorder.emit({
          kind: "run_finished",
          snapshot: runSnapshot({
            finished_at: "2026-03-24T05:32:02.200Z",
            phase: "completed",
            reason: "completed",
            run_id: runIds[index]!,
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
      const projects = openResult.db.select().from(projectTable).all()
      const workspaces = openResult.db.select().from(workspaceTable).all()
      expect(projects).toHaveLength(1)
      expect(projects[0]?.id).toBe(`git:${join(await realpath(main), ".git")}`)
      expect(workspaces).toHaveLength(2)
      expect(new Set(workspaces.map((row) => row.projectId))).toEqual(new Set([projects[0]!.id]))
      expect(findProjectId(openResult.db, main)).toBe(projects[0]?.id ?? null)
      expect(findProjectId(openResult.db, worktree)).toBe(projects[0]?.id ?? null)
      expect(findWorkspaceId(openResult.db, main)).not.toBe(findWorkspaceId(openResult.db, worktree))
    } finally {
      closeDb(openResult.db)
    }
  })
})
