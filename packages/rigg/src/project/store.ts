import { lstatSync, readFileSync, realpathSync } from "node:fs"
import { join, resolve } from "node:path"

import { eq } from "drizzle-orm"

import { tx, type Conn, type Db } from "../storage/db"
import type { WorkspacePaths } from "./index"
import { projectTable } from "./project.sql"
import { workspaceTable } from "./workspace.sql"

function canonical(path: string): string {
  try {
    return realpathSync.native(path)
  } catch (error) {
    if (shouldResolvePath(error)) {
      return resolve(path)
    }
    throw error
  }
}

function shouldResolvePath(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")
}

export type WorkspaceRef = {
  projectId: string
  workspaceId: string
}

function resolveGitCommonDir(rootDir: string): string | null {
  const dotgit = join(rootDir, ".git")
  try {
    const stat = lstatSync(dotgit)
    if (stat.isDirectory()) {
      return canonical(dotgit)
    }
    if (!stat.isFile()) {
      return null
    }

    const match = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotgit, "utf8"))
    if (match === null) {
      return null
    }

    const gitDirPath = match[1]
    if (gitDirPath === undefined) {
      return null
    }

    const gitDir = canonical(resolve(rootDir, gitDirPath))
    return canonical(resolve(gitDir, "..", ".."))
  } catch {
    return null
  }
}

function resolveProjectId(rootDir: string): string {
  const gitCommonDir = resolveGitCommonDir(rootDir)
  if (gitCommonDir !== null) {
    return `git:${gitCommonDir}`
  }

  return `path:${rootDir}`
}

export function findWorkspaceRef(db: Db, rootDir: string): WorkspaceRef | null {
  const root = canonical(rootDir)
  const row = db
    .select({
      projectId: workspaceTable.projectId,
      workspaceId: workspaceTable.id,
    })
    .from(workspaceTable)
    .where(eq(workspaceTable.rootDir, root))
    .get()
  return row ?? null
}

export function findProjectId(db: Db, rootDir: string): string | null {
  return findWorkspaceRef(db, rootDir)?.projectId ?? null
}

export function findWorkspaceId(db: Db, rootDir: string): string | null {
  return findWorkspaceRef(db, rootDir)?.workspaceId ?? null
}

export function ensureWorkspace(db: Conn, workspace: WorkspacePaths): WorkspaceRef {
  const root = canonical(workspace.rootDir)
  const rigg = canonical(workspace.riggDir)
  const projectId = resolveProjectId(root)
  const updatedAt = Date.now()

  return tx(db, (conn) => {
    conn.insert(projectTable).values({ id: projectId }).onConflictDoNothing().run()

    const workspaceRow = conn
      .insert(workspaceTable)
      .values({
        id: Bun.randomUUIDv7(),
        projectId,
        riggDir: rigg,
        rootDir: root,
      })
      .onConflictDoUpdate({
        set: {
          projectId,
          riggDir: rigg,
          updatedAt,
        },
        target: workspaceTable.rootDir,
      })
      .returning({
        projectId: workspaceTable.projectId,
        workspaceId: workspaceTable.id,
      })
      .get()

    if (workspaceRow === undefined) {
      throw new Error("failed to create history workspace row")
    }

    return workspaceRow
  })
}
