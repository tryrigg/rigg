import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runCommand } from "../../src/cli/show"
import { createRecorder } from "../../src/history/record"
import type { NodeSnapshot } from "../../src/session/schema"
import { runSnapshot } from "../fixture/builders"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

function nodeSnapshot(): NodeSnapshot {
  return {
    attempt: 1,
    duration_ms: 1200,
    exit_code: 0,
    finished_at: "2026-03-24T05:32:02.200Z",
    node_kind: "shell",
    node_path: "/0",
    result: null,
    started_at: "2026-03-24T05:32:01.000Z",
    status: "succeeded",
    stderr: null,
    stdout: "ok",
    user_id: "step",
    waiting_for: null,
  }
}

async function temp(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(path)
  return path
}

async function withDataHome<T>(dataHome: string, run: () => Promise<T>): Promise<T> {
  const original = process.env["XDG_DATA_HOME"]
  process.env["XDG_DATA_HOME"] = dataHome
  try {
    return await run()
  } finally {
    if (original === undefined) delete process.env["XDG_DATA_HOME"]
    else process.env["XDG_DATA_HOME"] = original
  }
}

describe("cli/show", () => {
  test("shows a stored run by short id", async () => {
    const workspace = await temp("rigg-show-workspace-")
    const dataHome = await temp("rigg-show-data-")
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await Bun.write(
      join(workspace, ".rigg", "plan.yaml"),
      "id: plan\nsteps:\n  - type: shell\n    with:\n      command: echo hi\n",
    )

    await withDataHome(dataHome, async () => {
      const recorder = await createRecorder({
        workflowId: "plan",
        workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
      })
      const node = nodeSnapshot()
      recorder.emit({
        kind: "run_started",
        snapshot: runSnapshot({ run_id: "d3f8a1c4-9e2b-4f7a-8d1c-3e5f7a9b2c4d", workflow_id: "plan" }),
      })
      recorder.emit({
        kind: "node_completed",
        node,
        snapshot: runSnapshot({ nodes: [node], run_id: "d3f8a1c4-9e2b-4f7a-8d1c-3e5f7a9b2c4d", workflow_id: "plan" }),
      })
      recorder.emit({
        kind: "run_finished",
        snapshot: runSnapshot({
          finished_at: "2026-03-24T05:32:02.200Z",
          nodes: [node],
          phase: "completed",
          reason: "completed",
          run_id: "d3f8a1c4-9e2b-4f7a-8d1c-3e5f7a9b2c4d",
          status: "succeeded",
          workflow_id: "plan",
        }),
      })
      await recorder.close()
    })

    const result = await withDataHome(dataHome, () => runCommand(workspace, "d3f8a1c"))
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines.join("\n")).toContain("▸ rigg · plan · d3f8a1c")
  })

  test("shows stored runs even if current workflows are invalid", async () => {
    const workspace = await temp("rigg-show-workspace-")
    const dataHome = await temp("rigg-show-data-")
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await Bun.write(
      join(workspace, ".rigg", "plan.yaml"),
      "id: plan\nsteps:\n  - type: shell\n    with:\n      command: echo hi\n",
    )

    await withDataHome(dataHome, async () => {
      const recorder = await createRecorder({
        workflowId: "plan",
        workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
      })
      recorder.emit({
        kind: "run_started",
        snapshot: runSnapshot({ run_id: "d3f8a1c4-9e2b-4f7a-8d1c-3e5f7a9b2c4d", workflow_id: "plan" }),
      })
      recorder.emit({
        kind: "run_finished",
        snapshot: runSnapshot({
          finished_at: "2026-03-24T05:32:02.200Z",
          phase: "completed",
          reason: "completed",
          run_id: "d3f8a1c4-9e2b-4f7a-8d1c-3e5f7a9b2c4d",
          status: "succeeded",
          workflow_id: "plan",
        }),
      })
      await recorder.close()
    })

    await Bun.write(join(workspace, ".rigg", "plan.yaml"), "id: [\n")

    const result = await withDataHome(dataHome, () => runCommand(workspace, "d3f8a1c"))
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines.join("\n")).toContain("▸ rigg · plan · d3f8a1c")
  })
})
