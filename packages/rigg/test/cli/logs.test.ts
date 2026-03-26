import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Database } from "bun:sqlite"
import { runCommand } from "../../src/cli/logs"
import { resolveDbPath } from "../../src/storage/db"
import { createRecorder } from "../../src/history/record"
import type { NodeSnapshot } from "../../src/session/schema"
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

function nodeSnapshot(): NodeSnapshot {
  return {
    attempt: 1,
    duration_ms: 1200,
    exit_code: 1,
    finished_at: "2026-03-24T05:32:02.200Z",
    node_kind: "shell",
    node_path: "/0",
    result: null,
    started_at: "2026-03-24T05:32:01.000Z",
    status: "failed",
    stderr: "Error: blocked",
    stdout: "Reviewing plan...",
    user_id: "code-review",
    waiting_for: null,
  }
}

async function recordRun(args: {
  dataHome: string
  runId: string
  stepId: string
  stdout: string
  workflowId: string
  workspace: string
}): Promise<void> {
  await withDataHome(args.dataHome, async () => {
    const recorder = await createRecorder({
      workflowId: args.workflowId,
      workspace: { riggDir: join(args.workspace, ".rigg"), rootDir: args.workspace },
    })
    const node = { ...nodeSnapshot(), stdout: args.stdout, user_id: args.stepId }
    recorder.emit({
      kind: "run_started",
      snapshot: runSnapshot({ run_id: args.runId, workflow_id: args.workflowId }),
    })
    recorder.emit({
      chunk: `${args.stdout}\n`,
      kind: "step_output",
      node_path: "/0",
      stream: "stdout",
      user_id: args.stepId,
    })
    recorder.emit({
      kind: "node_completed",
      node,
      snapshot: runSnapshot({ nodes: [node], run_id: args.runId, workflow_id: args.workflowId }),
    })
    recorder.emit({
      kind: "run_finished",
      snapshot: runSnapshot({
        finished_at: "2026-03-24T05:32:02.200Z",
        nodes: [node],
        phase: "failed",
        reason: "step_failed",
        run_id: args.runId,
        status: "failed",
        workflow_id: args.workflowId,
      }),
    })
    await recorder.close()
  })
}

describe("cli/logs", () => {
  test("shows logs for a named step from the latest run", async () => {
    const workspace = await temp("rigg-logs-workspace-")
    const dataHome = await temp("rigg-logs-data-")
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await Bun.write(
      join(workspace, ".rigg", "plan.yaml"),
      "id: plan\nsteps:\n  - id: code-review\n    type: shell\n    with:\n      command: echo hi\n",
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
        chunk: "Reviewing plan...\n",
        kind: "step_output",
        node_path: "/0",
        stream: "stdout",
        user_id: "code-review",
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
          phase: "failed",
          reason: "step_failed",
          run_id: "d3f8a1c4-9e2b-4f7a-8d1c-3e5f7a9b2c4d",
          status: "failed",
          workflow_id: "plan",
        }),
      })
      await recorder.close()
    })

    const result = await withDataHome(dataHome, () => runCommand(workspace, { first: "code-review", json: false }))
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines.join("\n")).toContain("Reviewing plan...")
  })

  test("preserves the positional run when --step is used", async () => {
    const workspace = await temp("rigg-logs-workspace-")
    const dataHome = await temp("rigg-logs-data-")
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await Bun.write(
      join(workspace, ".rigg", "plan.yaml"),
      "id: plan\nsteps:\n  - id: code-review\n    type: shell\n    with:\n      command: echo hi\n",
    )

    await recordRun({
      dataHome,
      runId: "1111111a-9e2b-4f7a-8d1c-3e5f7a9b2c4d",
      stepId: "code-review",
      stdout: "older run",
      workflowId: "plan",
      workspace,
    })
    await recordRun({
      dataHome,
      runId: "2222222b-9e2b-4f7a-8d1c-3e5f7a9b2c4d",
      stepId: "code-review",
      stdout: "latest run",
      workflowId: "plan",
      workspace,
    })

    const result = await withDataHome(dataHome, () =>
      runCommand(workspace, { first: "1111111", json: false, step: "code-review" }),
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines.join("\n")).toContain("older run")
    expect(result.stdoutLines.join("\n")).not.toContain("latest run")
  })

  test("uses the second positional argument as the step", async () => {
    const workspace = await temp("rigg-logs-workspace-")
    const dataHome = await temp("rigg-logs-data-")
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await Bun.write(
      join(workspace, ".rigg", "plan.yaml"),
      "id: plan\nsteps:\n  - id: code-review\n    type: shell\n    with:\n      command: echo hi\n  - id: build\n    type: shell\n    with:\n      command: echo build\n",
    )

    await withDataHome(dataHome, async () => {
      const recorder = await createRecorder({
        workflowId: "plan",
        workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
      })
      const review = { ...nodeSnapshot(), stdout: "code review output", user_id: "code-review" }
      const build = { ...nodeSnapshot(), node_path: "/1", stdout: "build output", user_id: "build" }
      const runId = "d3f8a1c4-9e2b-4f7a-8d1c-3e5f7a9b2c4d"
      recorder.emit({ kind: "run_started", snapshot: runSnapshot({ run_id: runId, workflow_id: "plan" }) })
      recorder.emit({
        chunk: "code review output\n",
        kind: "step_output",
        node_path: "/0",
        stream: "stdout",
        user_id: "code-review",
      })
      recorder.emit({
        chunk: "build output\n",
        kind: "step_output",
        node_path: "/1",
        stream: "stdout",
        user_id: "build",
      })
      recorder.emit({
        kind: "node_completed",
        node: review,
        snapshot: runSnapshot({ nodes: [review], run_id: runId, workflow_id: "plan" }),
      })
      recorder.emit({
        kind: "node_completed",
        node: build,
        snapshot: runSnapshot({ nodes: [review, build], run_id: runId, workflow_id: "plan" }),
      })
      recorder.emit({
        kind: "run_finished",
        snapshot: runSnapshot({
          finished_at: "2026-03-24T05:32:02.200Z",
          nodes: [review, build],
          phase: "failed",
          reason: "step_failed",
          run_id: runId,
          status: "failed",
          workflow_id: "plan",
        }),
      })
      await recorder.close()
    })

    const result = await withDataHome(dataHome, () =>
      runCommand(workspace, { first: "d3f8a1c", json: false, second: "build" }),
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines.join("\n")).toContain("build output")
    expect(result.stdoutLines.join("\n")).not.toContain("code review output")
  })

  test("selects anonymous steps by node path", async () => {
    const workspace = await temp("rigg-logs-workspace-")
    const dataHome = await temp("rigg-logs-data-")
    const runId = "4d62ab8e-2b4f-4f7a-8d1c-3e5f7a9b2c4d"
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
      const node = { ...nodeSnapshot(), stdout: "anonymous output", user_id: null }
      recorder.emit({ kind: "run_started", snapshot: runSnapshot({ run_id: runId, workflow_id: "plan" }) })
      recorder.emit({
        chunk: "anonymous output\n",
        kind: "step_output",
        node_path: "/0",
        stream: "stdout",
        user_id: null,
      })
      recorder.emit({
        kind: "node_completed",
        node,
        snapshot: runSnapshot({ nodes: [node], run_id: runId, workflow_id: "plan" }),
      })
      recorder.emit({
        kind: "run_finished",
        snapshot: runSnapshot({
          finished_at: "2026-03-24T05:32:02.200Z",
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

    const result = await withDataHome(dataHome, () =>
      runCommand(workspace, { first: "4d62ab8", json: false, second: "/0" }),
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines.join("\n")).toContain("anonymous output")
  })

  test("rejects ambiguous step ids and asks for node paths", async () => {
    const workspace = await temp("rigg-logs-workspace-")
    const dataHome = await temp("rigg-logs-data-")
    const runId = "5e73ab8e-2b4f-4f7a-8d1c-3e5f7a9b2c4d"
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await Bun.write(
      join(workspace, ".rigg", "plan.yaml"),
      "id: plan\nsteps:\n  - id: build\n    type: shell\n    with:\n      command: echo hi\n",
    )

    await withDataHome(dataHome, async () => {
      const recorder = await createRecorder({
        workflowId: "plan",
        workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
      })
      const firstNode = { ...nodeSnapshot(), stdout: "first", user_id: "build" }
      const secondNode = { ...nodeSnapshot(), node_path: "/1", stdout: "second", user_id: "build" }
      recorder.emit({ kind: "run_started", snapshot: runSnapshot({ run_id: runId, workflow_id: "plan" }) })
      recorder.emit({
        chunk: "first\n",
        kind: "step_output",
        node_path: "/0",
        stream: "stdout",
        user_id: "build",
      })
      recorder.emit({
        chunk: "second\n",
        kind: "step_output",
        node_path: "/1",
        stream: "stdout",
        user_id: "build",
      })
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
        kind: "run_finished",
        snapshot: runSnapshot({
          finished_at: "2026-03-24T05:32:02.200Z",
          nodes: [firstNode, secondNode],
          phase: "completed",
          reason: "completed",
          run_id: runId,
          status: "succeeded",
          workflow_id: "plan",
        }),
      })
      await recorder.close()
    })

    const result = await withDataHome(dataHome, () =>
      runCommand(workspace, { first: "5e73ab8", json: false, second: "build" }),
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderrLines).toContain('Step selector "build" matches 2 steps in run 5e73ab8e2b4f4.')
    expect(result.stderrLines).toContain("  build (/0)")
    expect(result.stderrLines).toContain("  build (/1)")
  })

  test("preserves the positional step when --run is used", async () => {
    const workspace = await temp("rigg-logs-workspace-")
    const dataHome = await temp("rigg-logs-data-")
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await Bun.write(
      join(workspace, ".rigg", "plan.yaml"),
      "id: plan\nsteps:\n  - id: code-review\n    type: shell\n    with:\n      command: echo hi\n  - id: build\n    type: shell\n    with:\n      command: echo build\n",
    )

    await withDataHome(dataHome, async () => {
      const recorder = await createRecorder({
        workflowId: "plan",
        workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
      })
      const review = { ...nodeSnapshot(), stdout: "code review output", user_id: "code-review" }
      const build = { ...nodeSnapshot(), node_path: "/1", stdout: "build output", user_id: "build" }
      recorder.emit({
        kind: "run_started",
        snapshot: runSnapshot({ run_id: "d3f8a1c4-9e2b-4f7a-8d1c-3e5f7a9b2c4d", workflow_id: "plan" }),
      })
      recorder.emit({
        chunk: "code review output\n",
        kind: "step_output",
        node_path: "/0",
        stream: "stdout",
        user_id: "code-review",
      })
      recorder.emit({
        chunk: "build output\n",
        kind: "step_output",
        node_path: "/1",
        stream: "stdout",
        user_id: "build",
      })
      recorder.emit({
        kind: "node_completed",
        node: review,
        snapshot: runSnapshot({
          nodes: [review],
          run_id: "d3f8a1c4-9e2b-4f7a-8d1c-3e5f7a9b2c4d",
          workflow_id: "plan",
        }),
      })
      recorder.emit({
        kind: "node_completed",
        node: build,
        snapshot: runSnapshot({
          nodes: [review, build],
          run_id: "d3f8a1c4-9e2b-4f7a-8d1c-3e5f7a9b2c4d",
          workflow_id: "plan",
        }),
      })
      recorder.emit({
        kind: "run_finished",
        snapshot: runSnapshot({
          finished_at: "2026-03-24T05:32:02.200Z",
          nodes: [review, build],
          phase: "failed",
          reason: "step_failed",
          run_id: "d3f8a1c4-9e2b-4f7a-8d1c-3e5f7a9b2c4d",
          status: "failed",
          workflow_id: "plan",
        }),
      })
      await recorder.close()
    })

    const result = await withDataHome(dataHome, () =>
      runCommand(workspace, { first: "build", json: false, run: "d3f8a1c" }),
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines.join("\n")).toContain("build output")
    expect(result.stdoutLines.join("\n")).not.toContain("code review output")
  })

  test("prefers the explicit run step over workflow shorthand collisions when --run is used", async () => {
    const workspace = await temp("rigg-logs-workspace-")
    const dataHome = await temp("rigg-logs-data-")
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await Bun.write(
      join(workspace, ".rigg", "build.yaml"),
      "id: build\nsteps:\n  - id: deploy\n    type: shell\n    with:\n      command: echo deploy\n",
    )
    await Bun.write(
      join(workspace, ".rigg", "plan.yaml"),
      "id: plan\nsteps:\n  - id: build\n    type: shell\n    with:\n      command: echo build\n",
    )

    await recordRun({
      dataHome,
      runId: "1111111a-9e2b-4f7a-8d1c-3e5f7a9b2c4d",
      stepId: "build",
      stdout: "explicit build output",
      workflowId: "plan",
      workspace,
    })
    await recordRun({
      dataHome,
      runId: "2222222b-9e2b-4f7a-8d1c-3e5f7a9b2c4d",
      stepId: "deploy",
      stdout: "workflow build output",
      workflowId: "build",
      workspace,
    })

    const result = await withDataHome(dataHome, () =>
      runCommand(workspace, { first: "build", json: false, run: "1111111" }),
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines.join("\n")).toContain("explicit build output")
    expect(result.stdoutLines.join("\n")).not.toContain("workflow build output")
  })

  test("preserves workflow shorthand when --run is used", async () => {
    const workspace = await temp("rigg-logs-workspace-")
    const dataHome = await temp("rigg-logs-data-")
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await Bun.write(
      join(workspace, ".rigg", "plan.yaml"),
      "id: plan\nsteps:\n  - id: code-review\n    type: shell\n    with:\n      command: echo hi\n",
    )

    await recordRun({
      dataHome,
      runId: "1111111a-9e2b-4f7a-8d1c-3e5f7a9b2c4d",
      stepId: "code-review",
      stdout: "explicit run output",
      workflowId: "plan",
      workspace,
    })
    await recordRun({
      dataHome,
      runId: "2222222b-9e2b-4f7a-8d1c-3e5f7a9b2c4d",
      stepId: "code-review",
      stdout: "latest workflow output",
      workflowId: "plan",
      workspace,
    })

    const result = await withDataHome(dataHome, () =>
      runCommand(workspace, { first: "plan", json: false, run: "1111111" }),
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines.join("\n")).toContain("explicit run output")
    expect(result.stdoutLines.join("\n")).not.toContain("latest workflow output")
  })

  test("does not treat a redundant positional run as --step when --run repeats the same id", async () => {
    const workspace = await temp("rigg-logs-workspace-")
    const dataHome = await temp("rigg-logs-data-")
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await Bun.write(
      join(workspace, ".rigg", "plan.yaml"),
      "id: plan\nsteps:\n  - id: code-review\n    type: shell\n    with:\n      command: echo hi\n",
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
        chunk: "Reviewing plan...\n",
        kind: "step_output",
        node_path: "/0",
        stream: "stdout",
        user_id: "code-review",
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
          phase: "failed",
          reason: "step_failed",
          run_id: "d3f8a1c4-9e2b-4f7a-8d1c-3e5f7a9b2c4d",
          status: "failed",
          workflow_id: "plan",
        }),
      })
      await recorder.close()
    })

    const result = await withDataHome(dataHome, () =>
      runCommand(workspace, { first: "d3f8a1c", json: false, run: "d3f8a1c" }),
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines.join("\n")).toContain("Reviewing plan...")
  })

  test("reports partial recordings instead of claiming the run had no output", async () => {
    const workspace = await temp("rigg-logs-workspace-")
    const dataHome = await temp("rigg-logs-data-")
    const runId = "6f84ab8e-2b4f-4f7a-8d1c-3e5f7a9b2c4d"
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await Bun.write(join(workspace, ".rigg", "plan.yaml"), "id: plan\nsteps: []\n")

    await withDataHome(dataHome, async () => {
      const recorder = await createRecorder({
        workflowId: "plan",
        workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
      })
      recorder.emit({ kind: "run_started", snapshot: runSnapshot({ run_id: runId, workflow_id: "plan" }) })
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

    const db = new Database(resolveDbPath({ XDG_DATA_HOME: dataHome }), { readwrite: true, strict: true })
    try {
      db.run("update run set recording_status = 'partial' where id = ?", [runId])
    } finally {
      db.close(false)
    }

    const result = await withDataHome(dataHome, () => runCommand(workspace, { first: "6f84ab8", json: false }))
    expect(result.exitCode).toBe(1)
    expect(result.stderrLines).toEqual(["Run 6f84ab8e2b4f4 was only partially recorded, and no output is available."])
  })

  test("treats a hex-like token as a workflow id before falling back to a run prefix", async () => {
    const workspace = await temp("rigg-logs-workspace-")
    const dataHome = await temp("rigg-logs-data-")
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await Bun.write(
      join(workspace, ".rigg", "deadbee.yaml"),
      "id: deadbee\nsteps:\n  - id: code-review\n    type: shell\n    with:\n      command: echo hi\n",
    )

    await recordRun({
      dataHome,
      runId: "cafef00d-9e2b-4f7a-8d1c-3e5f7a9b2c4d",
      stepId: "code-review",
      stdout: "workflow match",
      workflowId: "deadbee",
      workspace,
    })

    const result = await withDataHome(dataHome, () => runCommand(workspace, { first: "deadbee", json: false }))
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines.join("\n")).toContain("workflow match")
  })

  test("prefers a matching workflow id before the latest run step shorthand", async () => {
    const workspace = await temp("rigg-logs-workspace-")
    const dataHome = await temp("rigg-logs-data-")
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await Bun.write(
      join(workspace, ".rigg", "build.yaml"),
      "id: build\nsteps:\n  - id: deploy\n    type: shell\n    with:\n      command: echo deploy\n",
    )
    await Bun.write(
      join(workspace, ".rigg", "plan.yaml"),
      "id: plan\nsteps:\n  - id: build\n    type: shell\n    with:\n      command: echo build\n",
    )

    await recordRun({
      dataHome,
      runId: "1111111a-9e2b-4f7a-8d1c-3e5f7a9b2c4d",
      stepId: "deploy",
      stdout: "workflow build output",
      workflowId: "build",
      workspace,
    })
    await recordRun({
      dataHome,
      runId: "2222222b-9e2b-4f7a-8d1c-3e5f7a9b2c4d",
      stepId: "build",
      stdout: "latest step output",
      workflowId: "plan",
      workspace,
    })

    const result = await withDataHome(dataHome, () => runCommand(workspace, { first: "build", json: false }))
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines.join("\n")).toContain("workflow build output")
    expect(result.stdoutLines.join("\n")).not.toContain("latest step output")
  })

  test("shows logs even if current workflows are invalid", async () => {
    const workspace = await temp("rigg-logs-workspace-")
    const dataHome = await temp("rigg-logs-data-")
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await Bun.write(
      join(workspace, ".rigg", "plan.yaml"),
      "id: plan\nsteps:\n  - id: code-review\n    type: shell\n    with:\n      command: echo hi\n",
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
        chunk: "Reviewing plan...\n",
        kind: "step_output",
        node_path: "/0",
        stream: "stdout",
        user_id: "code-review",
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

    await Bun.write(join(workspace, ".rigg", "plan.yaml"), "id: [\n")

    const result = await withDataHome(dataHome, () => runCommand(workspace, { first: "code-review", json: false }))
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines.join("\n")).toContain("Reviewing plan...")
  })

  test("surfaces runs with no recorded output", async () => {
    const workspace = await temp("rigg-logs-workspace-")
    const dataHome = await temp("rigg-logs-data-")
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await Bun.write(
      join(workspace, ".rigg", "plan.yaml"),
      "id: plan\nsteps:\n  - id: code-review\n    type: shell\n    with:\n      command: echo hi\n",
    )

    await withDataHome(dataHome, async () => {
      const recorder = await createRecorder({
        workflowId: "plan",
        workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
      })
      const runId = "abcdef12-9e2b-4f7a-8d1c-3e5f7a9b2c4d"
      const node: NodeSnapshot = { ...nodeSnapshot(), stderr: null, stdout: null, status: "succeeded", exit_code: 0 }
      recorder.emit({
        kind: "run_started",
        snapshot: runSnapshot({ run_id: runId, workflow_id: "plan" }),
      })
      recorder.emit({
        kind: "node_completed",
        node,
        snapshot: runSnapshot({ nodes: [node], run_id: runId, workflow_id: "plan" }),
      })
      recorder.emit({
        kind: "run_finished",
        snapshot: runSnapshot({
          finished_at: "2026-03-24T05:32:02.200Z",
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

    const result = await withDataHome(dataHome, () => runCommand(workspace, { first: "abcdef1", json: false }))
    expect(result.exitCode).toBe(1)
    expect(result.stdoutLines).toEqual([])
    expect(result.stderrLines).toEqual(["No output recorded for run abcdef129e2b4."])
  })

  test("shows run-level events when no step output exists", async () => {
    const workspace = await temp("rigg-logs-workspace-")
    const dataHome = await temp("rigg-logs-data-")
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await Bun.write(
      join(workspace, ".rigg", "plan.yaml"),
      "id: plan\nsteps:\n  - id: code-review\n    type: shell\n    with:\n      command: echo hi\n",
    )

    await withDataHome(dataHome, async () => {
      const recorder = await createRecorder({
        workflowId: "plan",
        workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
      })
      const runId = "feedface-9e2b-4f7a-8d1c-3e5f7a9b2c4d"
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

    const result = await withDataHome(dataHome, () => runCommand(workspace, { first: "feedfac", json: false }))
    expect(result.exitCode).toBe(0)
    expect(result.stderrLines).toEqual([])
    expect(result.stdoutLines.join("\n")).toContain("▸ run")
    expect(result.stdoutLines.join("\n")).toContain("barrier resolved: continue")
  })

  test("treats step lookups with only run-level events as no step output", async () => {
    const workspace = await temp("rigg-logs-workspace-")
    const dataHome = await temp("rigg-logs-data-")
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await Bun.write(
      join(workspace, ".rigg", "plan.yaml"),
      "id: plan\nsteps:\n  - id: code-review\n    type: shell\n    with:\n      command: echo hi\n",
    )

    await withDataHome(dataHome, async () => {
      const recorder = await createRecorder({
        workflowId: "plan",
        workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
      })
      const runId = "deadc0de-9e2b-4f7a-8d1c-3e5f7a9b2c4d"
      const node: NodeSnapshot = { ...nodeSnapshot(), stderr: null, stdout: null, status: "succeeded", exit_code: 0 }
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
        kind: "node_completed",
        node,
        snapshot: runSnapshot({ nodes: [node], run_id: runId, workflow_id: "plan" }),
      })
      recorder.emit({
        kind: "run_finished",
        snapshot: runSnapshot({
          finished_at: "2026-03-24T05:32:02.200Z",
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

    const result = await withDataHome(dataHome, () =>
      runCommand(workspace, { first: "deadc0d", json: false, second: "code-review" }),
    )
    expect(result.exitCode).toBe(1)
    expect(result.stdoutLines).toEqual([])
    expect(result.stderrLines).toEqual(['No output recorded for step "code-review" in run deadc0de9e2b4.'])
  })

  test("treats empty-text step events as no step output", async () => {
    const workspace = await temp("rigg-logs-workspace-")
    const dataHome = await temp("rigg-logs-data-")
    await mkdir(join(workspace, ".rigg"), { recursive: true })
    await Bun.write(
      join(workspace, ".rigg", "plan.yaml"),
      "id: plan\nsteps:\n  - id: code-review\n    type: shell\n    with:\n      command: echo hi\n",
    )

    await withDataHome(dataHome, async () => {
      const recorder = await createRecorder({
        workflowId: "plan",
        workspace: { riggDir: join(workspace, ".rigg"), rootDir: workspace },
      })
      const runId = "cab005e5-9e2b-4f7a-8d1c-3e5f7a9b2c4d"
      const node: NodeSnapshot = { ...nodeSnapshot(), stderr: null, stdout: null, status: "succeeded", exit_code: 0 }
      recorder.emit({
        kind: "run_started",
        snapshot: runSnapshot({ run_id: runId, workflow_id: "plan" }),
      })
      recorder.emit({
        event: {
          itemId: "msg_1",
          kind: "message_completed",
          provider: "codex",
          text: "",
          threadId: "thread_1",
          turnId: "turn_1",
        },
        kind: "provider_event",
        node_path: "/0",
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
          finished_at: "2026-03-24T05:32:02.200Z",
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

    const result = await withDataHome(dataHome, () =>
      runCommand(workspace, { first: "cab005e", json: false, second: "code-review" }),
    )
    expect(result.exitCode).toBe(1)
    expect(result.stdoutLines).toEqual([])
    expect(result.stderrLines).toEqual(['No output recorded for step "code-review" in run cab005e59e2b4.'])
  })
})
