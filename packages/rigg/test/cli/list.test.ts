import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runCommand } from "../../src/cli/list"
import { createRecorder } from "../../src/history/record"
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

describe("cli/list", () => {
  test("lists workflows without requiring a database", async () => {
    const workspace = await temp("rigg-list-workspace-")
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await Bun.write(
      join(workspace, ".rigg", "plan.yaml"),
      "id: plan\nsteps:\n  - type: shell\n    with:\n      command: echo hi\n",
    )
    await Bun.write(
      join(workspace, ".rigg", "review.yaml"),
      "id: review\nsteps:\n  - type: shell\n    with:\n      command: echo hi\n",
    )

    const result = await runCommand(workspace)
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines.join("\n")).toContain("plan")
    expect(result.stdoutLines.join("\n")).toContain("—")
  })

  test("enriches list with last run status when history exists", async () => {
    const workspace = await temp("rigg-list-workspace-")
    const dataHome = await temp("rigg-list-data-")
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
          finished_at: "2026-03-24T05:32:05.000Z",
          phase: "completed",
          reason: "completed",
          run_id: "d3f8a1c4-9e2b-4f7a-8d1c-3e5f7a9b2c4d",
          status: "succeeded",
          workflow_id: "plan",
        }),
      })
      await recorder.close()
    })

    const result = await withDataHome(dataHome, () => runCommand(workspace))
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines.join("\n")).toContain("succeeded")
  })

  test("keeps listing workflows when the history database cannot be read", async () => {
    const workspace = await temp("rigg-list-workspace-")
    const dataHome = await temp("rigg-list-data-")
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await mkdir(join(dataHome, "rigg"), { recursive: true })
    await Bun.write(
      join(workspace, ".rigg", "plan.yaml"),
      "id: plan\nsteps:\n  - type: shell\n    with:\n      command: echo hi\n",
    )
    await Bun.write(join(dataHome, "rigg", "rigg.db"), "not a sqlite database")

    const result = await withDataHome(dataHome, () => runCommand(workspace))
    expect(result.exitCode).toBe(0)
    expect(result.stderrLines.join("\n")).toContain("Run history database is corrupted")
    expect(result.stdoutLines.join("\n")).toContain("plan")
  })

  test("keeps listing valid workflows when one workflow file is malformed", async () => {
    const workspace = await temp("rigg-list-workspace-")
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await Bun.write(
      join(workspace, ".rigg", "plan.yaml"),
      "id: plan\nsteps:\n  - type: shell\n    with:\n      command: echo hi\n",
    )
    await Bun.write(join(workspace, ".rigg", "broken.yaml"), "id: [\n")

    const result = await runCommand(workspace)
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines.join("\n")).toContain("plan")
    expect(result.stdoutLines.join("\n")).not.toContain("broken")
    expect(result.stderrLines.join("\n")).toContain("invalid_yaml")
  })

  test("does not suggest init when workflow files exist but all are invalid", async () => {
    const workspace = await temp("rigg-list-workspace-")
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await Bun.write(join(workspace, ".rigg", "broken.yaml"), "id: [\n")

    const result = await runCommand(workspace)
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines).toEqual([])
    expect(result.stderrLines.join("\n")).toContain("invalid_yaml")
    expect(result.stderrLines.join("\n")).not.toContain("rigg init")
  })

  test("omits duplicate workflow ids from the rendered list", async () => {
    const workspace = await temp("rigg-list-workspace-")
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await Bun.write(
      join(workspace, ".rigg", "plan-a.yaml"),
      "id: plan\nsteps:\n  - type: shell\n    with:\n      command: echo first\n",
    )
    await Bun.write(
      join(workspace, ".rigg", "plan-b.yaml"),
      "id: plan\nsteps:\n  - type: shell\n    with:\n      command: echo second\n  - type: shell\n    with:\n      command: echo third\n",
    )
    await Bun.write(
      join(workspace, ".rigg", "review.yaml"),
      "id: review\nsteps:\n  - type: shell\n    with:\n      command: echo hi\n",
    )

    const result = await runCommand(workspace)

    expect(result.exitCode).toBe(0)
    expect(result.stderrLines.join("\n")).toContain("duplicate_workflow_id")
    expect(result.stdoutLines.join("\n")).toContain("review")
    expect(result.stdoutLines.join("\n")).not.toContain("plan")
  })

  test("keeps older workflow history visible after more than 1000 newer runs", async () => {
    const workspace = await temp("rigg-list-workspace-")
    const dataHome = await temp("rigg-list-data-")
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
        const recorder = await createRecorder({
          workflowId: "plan",
          workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
        })
        recorder.emit({
          kind: "run_started",
          snapshot: runSnapshot({
            run_id: `20000000-0000-4000-8000-${n}`,
            started_at: `2026-03-24T05:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
            workflow_id: "plan",
          }),
        })
        recorder.emit({
          kind: "run_finished",
          snapshot: runSnapshot({
            finished_at: `2026-03-24T05:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.500Z`,
            phase: "completed",
            reason: "completed",
            run_id: `20000000-0000-4000-8000-${n}`,
            started_at: `2026-03-24T05:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
            status: "succeeded",
            workflow_id: "plan",
          }),
        })
        await recorder.close()
      }
    })

    const result = await withDataHome(dataHome, () => runCommand(workspace))
    const reviewLine = result.stdoutLines.find((line) => line.includes("review")) ?? ""
    expect(result.exitCode).toBe(0)
    expect(reviewLine).toContain("review")
    expect(reviewLine).toContain("succeeded")
  })
})
