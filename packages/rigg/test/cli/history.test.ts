import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Database } from "bun:sqlite"
import { runCommand } from "../../src/cli/history"
import { createRecorder } from "../../src/history/record"
import { resolveDbPath } from "../../src/storage/db"
import { runSnapshot } from "../fixture/builders"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

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

async function seed(workspace: string, dataHome: string): Promise<void> {
  await mkdir(join(workspace, ".rigg"), { recursive: true })
  await Bun.write(
    join(workspace, ".rigg", "plan.yaml"),
    ["id: plan", "steps:", "  - id: step", "    type: shell", "    with:", "      command: echo hi"].join("\n"),
  )
  await withDataHome(dataHome, async () => {
    const recorder = await createRecorder({
      workflowId: "plan",
      workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
    })
    const snapshot = runSnapshot({
      finished_at: "2026-03-24T05:32:05.000Z",
      phase: "completed",
      reason: "completed",
      run_id: "d3f8a1c4-9e2b-4f7a-8d1c-3e5f7a9b2c4d",
      status: "succeeded",
      workflow_id: "plan",
    })
    recorder.emit({ kind: "run_started", snapshot: runSnapshot({ run_id: snapshot.run_id, workflow_id: "plan" }) })
    recorder.emit({ kind: "run_finished", snapshot })
    await recorder.close()
  })
}

describe("cli/history", () => {
  test("prints empty state without a database", async () => {
    const workspace = await temp("rigg-history-workspace-")
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await Bun.write(
      join(workspace, ".rigg", "plan.yaml"),
      "id: plan\nsteps:\n  - type: shell\n    with:\n      command: echo hi\n",
    )

    const result = await runCommand(workspace, { json: false, limit: 10, offset: 0 })
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines.join("\n")).toContain("No runs recorded yet")
  })

  test("returns an empty array for json output without history", async () => {
    const workspace = await temp("rigg-history-workspace-")
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await Bun.write(
      join(workspace, ".rigg", "plan.yaml"),
      "id: plan\nsteps:\n  - type: shell\n    with:\n      command: echo hi\n",
    )

    const result = await runCommand(workspace, { json: true, limit: 10, offset: 0 })
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines).toEqual(["[]"])
  })

  test("prints empty state when the history store cannot be created", async () => {
    const workspace = await temp("rigg-history-workspace-")
    const dataHome = await temp("rigg-history-data-")
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await mkdir(join(dataHome, "rigg"), { recursive: true })
    await chmod(join(dataHome, "rigg"), 0o555)
    await Bun.write(
      join(workspace, ".rigg", "plan.yaml"),
      "id: plan\nsteps:\n  - type: shell\n    with:\n      command: echo hi\n",
    )

    const result = await withDataHome(dataHome, () => runCommand(workspace, { json: false, limit: 10, offset: 0 }))
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines.join("\n")).toContain("No runs recorded yet")
    expect(result.stderrLines.join("\n")).toContain("Could not initialize run history database")
  })

  test("returns an empty array when the history store cannot be created", async () => {
    const workspace = await temp("rigg-history-workspace-")
    const dataHome = await temp("rigg-history-data-")
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await mkdir(join(dataHome, "rigg"), { recursive: true })
    await chmod(join(dataHome, "rigg"), 0o555)
    await Bun.write(
      join(workspace, ".rigg", "plan.yaml"),
      "id: plan\nsteps:\n  - type: shell\n    with:\n      command: echo hi\n",
    )

    const result = await withDataHome(dataHome, () => runCommand(workspace, { json: true, limit: 10, offset: 0 }))
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines).toEqual(["[]"])
    expect(result.stderrLines.join("\n")).toContain("Could not initialize run history database")
  })

  test("renders recorded runs as text and json", async () => {
    const workspace = await temp("rigg-history-workspace-")
    const dataHome = await temp("rigg-history-data-")
    await seed(workspace, dataHome)

    const textResult = await withDataHome(dataHome, () => runCommand(workspace, { json: false, limit: 10, offset: 0 }))
    expect(textResult.exitCode).toBe(0)
    expect(textResult.stdoutLines.join("\n")).toContain("d3f8a1c")

    const jsonResult = await withDataHome(dataHome, () => runCommand(workspace, { json: true, limit: 10, offset: 0 }))
    expect(jsonResult.exitCode).toBe(0)
    expect(jsonResult.stdoutLines.join("\n")).toContain('"workflow_id": "plan"')
    expect(jsonResult.stdoutLines.join("\n")).toContain('"recording_status": "complete"')
  })

  test("keeps partial recording status in json rows", async () => {
    const workspace = await temp("rigg-history-workspace-")
    const dataHome = await temp("rigg-history-data-")
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await Bun.write(
      join(workspace, ".rigg", "plan.yaml"),
      ["id: plan", "steps:", "  - id: step", "    type: shell", "    with:", "      command: echo hi"].join("\n"),
    )

    await withDataHome(dataHome, async () => {
      const recorder = await createRecorder({
        workflowId: "plan",
        workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
      })
      recorder.emit({
        kind: "run_started",
        snapshot: runSnapshot({
          run_id: "d3f8a1c4-9e2b-4f7a-8d1c-3e5f7a9b2c4d",
          status: "running",
          workflow_id: "plan",
        }),
      })
      const closeResult = await recorder.close()
      expect(closeResult.recording_status).toBe("complete")
    })

    const db = new Database(resolveDbPath({ XDG_DATA_HOME: dataHome }), { readwrite: true, strict: true })
    try {
      db.run("update run set recording_status = 'partial'")
    } finally {
      db.close(false)
    }

    const result = await withDataHome(dataHome, () => runCommand(workspace, { json: true, limit: 10, offset: 0 }))
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines.join("\n")).toContain('"recording_status": "partial"')
  })

  test("reads recorded history even if current workflows are invalid", async () => {
    const workspace = await temp("rigg-history-workspace-")
    const dataHome = await temp("rigg-history-data-")
    await seed(workspace, dataHome)
    await Bun.write(join(workspace, ".rigg", "plan.yaml"), "id: [\n")

    const result = await withDataHome(dataHome, () => runCommand(workspace, { json: false, limit: 10, offset: 0 }))
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines.join("\n")).toContain("d3f8a1c")
  })

  test("reports an empty page distinctly from an empty history", async () => {
    const workspace = await temp("rigg-history-workspace-")
    const dataHome = await temp("rigg-history-data-")
    await seed(workspace, dataHome)

    const result = await withDataHome(dataHome, () => runCommand(workspace, { json: false, limit: 10, offset: 100 }))
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines).toEqual(["No runs found at offset 100."])
  })

  test("reports an empty workflow page distinctly from missing workflow history", async () => {
    const workspace = await temp("rigg-history-workspace-")
    const dataHome = await temp("rigg-history-data-")
    await seed(workspace, dataHome)

    const result = await withDataHome(dataHome, () =>
      runCommand(workspace, { json: false, limit: 10, offset: 100, workflowId: "plan" }),
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines).toEqual(['No runs found for workflow "plan" at offset 100.'])
  })

  test("reports an empty status filter distinctly from empty history", async () => {
    const workspace = await temp("rigg-history-workspace-")
    const dataHome = await temp("rigg-history-data-")
    await seed(workspace, dataHome)

    const result = await withDataHome(dataHome, () =>
      runCommand(workspace, { json: false, limit: 10, offset: 0, status: "failed" }),
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines).toEqual(['No runs found with status "failed".'])
  })

  test("treats a zero limit as an empty page in text and json output", async () => {
    const workspace = await temp("rigg-history-workspace-")
    const dataHome = await temp("rigg-history-data-")
    await seed(workspace, dataHome)

    const textResult = await withDataHome(dataHome, () => runCommand(workspace, { json: false, limit: 0, offset: 0 }))
    expect(textResult.exitCode).toBe(0)
    expect(textResult.stdoutLines).toEqual([])

    const jsonResult = await withDataHome(dataHome, () => runCommand(workspace, { json: true, limit: 0, offset: 0 }))
    expect(jsonResult.exitCode).toBe(0)
    expect(jsonResult.stdoutLines).toEqual(["[]"])
  })
})
