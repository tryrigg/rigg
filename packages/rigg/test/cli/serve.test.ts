import { afterEach, describe, expect, test } from "bun:test"

import { runCommand } from "../../src/cli/serve"
import { createState, createApp, type ActiveRun } from "../../src/server/routes"
import type { ServerEvent } from "../../src/server/events"
import { runSnapshot } from "../fixture/builders"
import { cleanupTempDirs, createTempDir, seedRecordedRun, withDataHome, writeWorkflow } from "../fixture/history"
import type { RecordingStatus } from "../../src/history/history.sql"

const tempDirs: string[] = []

afterEach(async () => {
  await cleanupTempDirs(tempDirs)
})

function snapshot(runId = "run-live") {
  return {
    duration_ms: null,
    finished_at: null,
    nodes: [],
    reason: null,
    recording_status: "partial" as RecordingStatus,
    run_id: runId,
    short_id: runId.slice(0, 8),
    started_at: "2026-03-30T00:00:00.000Z",
    status: "running" as const,
    workflow_id: "plan",
  }
}

function activeRun(
  input: Partial<ActiveRun> & {
    resolveInteraction?: ActiveRun["resolveInteraction"]
    runId?: string
    rootDir?: string
    status?: ActiveRun["status"]
  } = {},
) {
  const subscribers = new Set<(event: ServerEvent) => void>()
  const abort = new AbortController()
  const runId = input.runId ?? "run-live"
  const run = input.snapshot ?? (() => snapshot(runId))
  const value: ActiveRun = {
    abort,
    resolveInteraction:
      input.resolveInteraction ??
      (() => {
        return { kind: "ok" }
      }),
    rootDir: input.rootDir ?? "/workspace",
    runId,
    snapshot: run,
    status: input.status ?? (() => "running"),
    subscribe: (send) => {
      subscribers.add(send)
      return () => {
        subscribers.delete(send)
      }
    },
  }

  return {
    emit: (event: ServerEvent) => {
      for (const send of subscribers) {
        send(event)
      }
    },
    run: value,
    size: () => subscribers.size,
  }
}

describe("cli/serve", () => {
  test("prints plain startup output", async () => {
    const stdout: string[] = []
    const exitCode = await runCommand(
      process.cwd(),
      { host: "127.0.0.1", json: false, kind: "serve", port: 3000 },
      {
        createAppImpl: (state) => createApp(state),
        onStdoutLine: (line) => {
          stdout.push(line)
        },
        serveImpl: (() => ({ port: 3847, stop() {} })) as never,
        waitForStopImpl: async (stop) => {
          await stop()
        },
      },
    )

    expect(exitCode).toBe(0)
    expect(stdout).toEqual(["Listening on http://127.0.0.1:3847"])
  })

  test("prints json startup output", async () => {
    const stdout: string[] = []
    const exitCode = await runCommand(
      process.cwd(),
      { host: "127.0.0.1", json: true, kind: "serve", port: 3000 },
      {
        createAppImpl: (state) => createApp(state),
        onStdoutLine: (line) => {
          stdout.push(line)
        },
        serveImpl: (() => ({ port: 3847, stop() {} })) as never,
        waitForStopImpl: async (stop) => {
          await stop()
        },
      },
    )

    expect(exitCode).toBe(0)
    expect(stdout).toEqual(['{"host":"127.0.0.1","port":3847,"url":"http://127.0.0.1:3847"}'])
  })

  test("routes validate workspace headers and roots", async () => {
    const state = createState()
    const app = createApp(state)
    const noHeader = await app.request("/api/workflows")
    expect(noHeader.status).toBe(400)

    const invalid = await app.request("/api/workflows", {
      headers: {
        "x-rigg-root": "/definitely/missing",
      },
    })
    expect(invalid.status).toBe(400)

    const root = await createTempDir(tempDirs, "rigg-serve-root-")
    const noRigg = await app.request("/api/workflows", {
      headers: {
        "x-rigg-root": root,
      },
    })
    expect(noRigg.status).toBe(404)

    await writeWorkflow(root)
    const noWorkspace = await app.request("/api/workflows", {
      headers: {
        "x-rigg-root": root,
      },
    })
    expect(noWorkspace.status).toBe(404)
    expect(await noWorkspace.json()).toEqual({
      error: {
        code: "workspace_not_found",
        message: `failed to resolve workspace for root ${root}: no workspace history exists yet. Start a run from this workspace, then retry.`,
      },
    })
  })

  test("lists workflows and runs for a known workspace", async () => {
    const root = await createTempDir(tempDirs, "rigg-serve-workspace-")
    const dataHome = await createTempDir(tempDirs, "rigg-serve-data-")
    await writeWorkflow(root)
    const runId = await seedRecordedRun(root, dataHome)
    await withDataHome(dataHome, async () => {
      const app = createApp(createState())

      const workflows = await app.request("/api/workflows", {
        headers: {
          "x-rigg-root": root,
        },
      })
      expect(workflows.status).toBe(200)
      expect(await workflows.json()).toEqual({
        errors: [],
        workflows: [
          {
            path: ".rigg/plan.yaml",
            workflow_id: "plan",
          },
        ],
      })

      const runs = await app.request("/api/runs", {
        headers: {
          "x-rigg-root": root,
        },
      })
      expect(runs.status).toBe(200)
      const payload = (await runs.json()) as { runs: Array<{ run_id: string }> }
      expect(payload.runs).toHaveLength(1)
      expect(payload.runs[0]?.run_id).toBe(runId)
    })
  })

  test("starts a run through POST /api/runs", async () => {
    const root = await createTempDir(tempDirs, "rigg-serve-start-")
    const dataHome = await createTempDir(tempDirs, "rigg-serve-start-data-")
    await writeWorkflow(root)
    await seedRecordedRun(root, dataHome)
    await withDataHome(dataHome, async () => {
      const app = createApp(createState())

      const response = await app.request("/api/runs", {
        body: JSON.stringify({
          inputs: {},
          workflow_id: "plan",
        }),
        headers: {
          "content-type": "application/json",
          "x-rigg-root": root,
        },
        method: "POST",
      })

      expect(response.status).toBe(202)
      const payload = (await response.json()) as { run: { run_id: string; workflow_id: string } }
      expect(payload.run.workflow_id).toBe("plan")
      expect(payload.run.run_id).toMatch(/[0-9a-f-]{36}/)
    })
  })

  test("aborts serve-owned runs and rejects historical ones", async () => {
    const state = createState()
    const live = activeRun()
    state.activeRuns.set(live.run.runId, live.run)
    const root = await createTempDir(tempDirs, "rigg-serve-abort-")
    const dataHome = await createTempDir(tempDirs, "rigg-serve-abort-data-")
    await writeWorkflow(root)
    const runId = await seedRecordedRun(root, dataHome)
    await withDataHome(dataHome, async () => {
      const app = createApp(state)

      const liveResponse = await app.request(`/api/runs/${live.run.runId}/abort`, {
        method: "POST",
      })
      expect(liveResponse.status).toBe(202)
      expect(live.run.abort.signal.aborted).toBe(true)

      const historical = await app.request(`/api/runs/${runId}/abort`, {
        method: "POST",
      })
      expect(historical.status).toBe(409)
    })
  })

  test("resolves serve-owned interactions and rejects historical ones", async () => {
    const seen: unknown[] = []
    const state = createState()
    const live = activeRun({
      resolveInteraction: (_interactionId, body) => {
        seen.push(body)
        return { kind: "ok" }
      },
      runId: "run-interaction",
    })
    state.activeRuns.set(live.run.runId, live.run)
    const root = await createTempDir(tempDirs, "rigg-serve-interaction-")
    const dataHome = await createTempDir(tempDirs, "rigg-serve-interaction-data-")
    await writeWorkflow(root)
    const runId = await seedRecordedRun(root, dataHome)
    await withDataHome(dataHome, async () => {
      const app = createApp(state)

      const liveResponse = await app.request(`/api/runs/${live.run.runId}/interactions/interaction-1`, {
        body: JSON.stringify({ decision: "approve" }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      })
      expect(liveResponse.status).toBe(202)
      expect(seen).toEqual([{ decision: "approve" }])

      const historical = await app.request(`/api/runs/${runId}/interactions/interaction-1`, {
        body: JSON.stringify({ decision: "approve" }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      })
      expect(historical.status).toBe(409)
    })
  })

  test("streams snapshot and updates over SSE", async () => {
    const state = createState()
    const live = activeRun()
    state.activeRuns.set(live.run.runId, live.run)
    const app = createApp(state)
    const response = await app.request(`/api/runs/${live.run.runId}/events`)

    expect(response.status).toBe(200)
    live.emit({ event: { kind: "run_started", snapshot: runSnapshot({ run_id: live.run.runId }) }, kind: "run" })
    live.emit({ kind: "done", status: "succeeded" })

    const text = await new Response(response.body).text()
    expect(text).toContain("event: snapshot")
    expect(text).toContain('"kind":"snapshot"')
    expect(text).toContain('"kind":"run"')
    expect(text).toContain('"kind":"done"')
  })

  test("disconnect removes the active SSE subscriber", async () => {
    const state = createState()
    const live = activeRun()
    state.activeRuns.set(live.run.runId, live.run)
    const app = createApp(state)
    const controller = new AbortController()
    const response = await app.request(
      new Request(`http://localhost/api/runs/${live.run.runId}/events`, {
        signal: controller.signal,
      }),
    )

    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    await reader?.read()
    expect(live.size()).toBe(1)
    controller.abort()
    await Bun.sleep(0)
    expect(live.size()).toBe(0)
  })

  test("historical event streams close cleanly and unknown runs return 404", async () => {
    const root = await createTempDir(tempDirs, "rigg-serve-events-")
    const dataHome = await createTempDir(tempDirs, "rigg-serve-events-data-")
    await writeWorkflow(root)
    const runId = await seedRecordedRun(root, dataHome)
    await withDataHome(dataHome, async () => {
      const app = createApp(createState())

      const response = await app.request(`/api/runs/${runId}/events`)
      expect(response.status).toBe(200)
      const text = await new Response(response.body).text()
      expect(text).toContain('"kind":"snapshot"')
      expect(text).toContain('"kind":"done"')

      const missing = await app.request("/api/runs/missing/events")
      expect(missing.status).toBe(404)
    })
  })
})
