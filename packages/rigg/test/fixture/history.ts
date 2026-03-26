import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import type { NodeSnapshot } from "../../src/session/schema"
import { createRecorder } from "../../src/history/record"
import { runSnapshot } from "./builders"

export async function cleanupTempDirs(tempDirs: string[]): Promise<void> {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })))
}

export async function createTempDir(tempDirs: string[], prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(path)
  return path
}

export async function withDataHome<T>(dataHome: string, run: () => Promise<T>): Promise<T> {
  const original = process.env["XDG_DATA_HOME"]
  process.env["XDG_DATA_HOME"] = dataHome
  try {
    return await run()
  } finally {
    if (original === undefined) {
      delete process.env["XDG_DATA_HOME"]
    } else {
      process.env["XDG_DATA_HOME"] = original
    }
  }
}

export async function writeWorkflow(workspace: string): Promise<void> {
  await mkdir(join(workspace, ".rigg"), { recursive: true })
  await Bun.write(
    join(workspace, ".rigg", "plan.yaml"),
    ["id: plan", "steps:", "  - id: code-review", "    type: shell", "    with:", "      command: echo hi"].join("\n"),
  )
}

export function nodeSnapshot(overrides: Partial<NodeSnapshot>): NodeSnapshot {
  return {
    attempt: overrides.attempt ?? 1,
    duration_ms: overrides.duration_ms ?? null,
    exit_code: overrides.exit_code ?? null,
    finished_at: overrides.finished_at ?? null,
    node_kind: overrides.node_kind ?? "shell",
    node_path: overrides.node_path ?? "/0",
    progress: overrides.progress,
    result: "result" in overrides ? (overrides.result ?? null) : null,
    started_at: overrides.started_at ?? "2026-03-24T05:32:01.000Z",
    status: overrides.status ?? "running",
    stderr: "stderr" in overrides ? (overrides.stderr ?? null) : null,
    stdout: "stdout" in overrides ? (overrides.stdout ?? null) : null,
    user_id: overrides.user_id ?? "code-review",
    waiting_for: overrides.waiting_for ?? null,
  }
}

export async function seedRecordedRun(workspace: string, dataHome: string): Promise<string> {
  const runId = "d3f8a1c4-9e2b-4f7a-8d1c-3e5f7a9b2c4d"
  await withDataHome(dataHome, async () => {
    const recorder = await createRecorder({
      workflowId: "plan",
      workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
    })

    const started = runSnapshot({
      run_id: runId,
      started_at: "2026-03-24T05:32:01.000Z",
      workflow_id: "plan",
    })
    recorder.emit({ kind: "run_started", snapshot: started })

    const startedNode = nodeSnapshot({})
    recorder.emit({
      kind: "node_started",
      node: startedNode,
      snapshot: runSnapshot({ nodes: [startedNode], run_id: runId, workflow_id: "plan" }),
    })
    recorder.emit({
      chunk: "Reviewing plan...\n",
      kind: "step_output",
      node_path: "/0",
      stream: "stdout",
      user_id: "code-review",
    })

    const finishedNode = nodeSnapshot({
      duration_ms: 3900,
      finished_at: "2026-03-24T05:32:05.000Z",
      status: "failed",
      stderr: "Error: blocked",
    })
    recorder.emit({
      kind: "node_completed",
      node: finishedNode,
      snapshot: runSnapshot({
        nodes: [finishedNode],
        reason: "step_failed",
        run_id: runId,
        workflow_id: "plan",
      }),
    })
    recorder.emit({
      kind: "run_finished",
      snapshot: runSnapshot({
        finished_at: "2026-03-24T05:32:05.000Z",
        nodes: [finishedNode],
        phase: "failed",
        reason: "step_failed",
        run_id: runId,
        status: "failed",
        workflow_id: "plan",
      }),
    })

    await recorder.close()
  })

  return runId
}

const storageDbUrl = pathToFileURL(join(import.meta.dir, "..", "..", "src", "storage", "db.ts")).href
const projectStoreUrl = pathToFileURL(join(import.meta.dir, "..", "..", "src", "project", "store.ts")).href

export async function runProjectWorker(input: {
  dataHome: string
  gate: string
  workspace?: { riggDir: string; rootDir: string }
}): Promise<unknown> {
  const proc = Bun.spawn({
    cmd: [
      "bun",
      "--eval",
      `
        const mod = await import(${JSON.stringify(storageDbUrl)})
        const project = await import(${JSON.stringify(projectStoreUrl)})
        const input = ${JSON.stringify(input)}
        while (!(await Bun.file(input.gate).exists())) {
          await Bun.sleep(10)
        }
        const result = await mod.openDb({ env: { XDG_DATA_HOME: input.dataHome } })
        if (result.kind !== "ok") {
          console.log(JSON.stringify(result))
          process.exit(0)
        }
        const id = input.workspace ? project.ensureWorkspace(result.db, input.workspace).workspaceId : null
        mod.closeDb(result.db)
        console.log(JSON.stringify({ id, kind: result.kind }))
      `,
    ],
    cwd: process.cwd(),
    env: process.env,
    stderr: "pipe",
    stdout: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(stderr || `worker exited with code ${code}`)
  }
  return JSON.parse(stdout.trim())
}
