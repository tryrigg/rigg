import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { readStatuses } from "../../src/history/query"

describe("history/query", () => {
  test("ignores staging, non-run, and incomplete run directories", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "rigg-history-query-"))
    const runsDir = join(projectRoot, ".rigg", "runs")
    await mkdir(runsDir, { recursive: true })

    try {
      await mkdir(join(runsDir, "019cc300-0000-7000-8000-000000000001"), { recursive: true })
      await mkdir(join(runsDir, "019cc300-0000-7000-8000-000000000002"), { recursive: true })
      await mkdir(join(runsDir, ".tmp-019cc300-0000-7000-8000-000000000003"), { recursive: true })
      await mkdir(join(runsDir, "notes"), { recursive: true })

      await writeFile(
        join(runsDir, "019cc300-0000-7000-8000-000000000001", "state.json"),
        JSON.stringify({
          conversations: {},
          finished_at: null,
          nodes: [],
          reason: null,
          run_id: "019cc300-0000-7000-8000-000000000001",
          started_at: "2026-03-14T00:00:00.000Z",
          status: "running",
          workflow_id: "workflow",
        }),
        "utf8",
      )
      await writeFile(
        join(runsDir, "019cc300-0000-7000-8000-000000000002", "meta.json"),
        JSON.stringify({ run_id: "019cc300-0000-7000-8000-000000000002" }),
        "utf8",
      )
      await writeFile(
        join(runsDir, ".tmp-019cc300-0000-7000-8000-000000000003", "state.json"),
        JSON.stringify({
          conversations: {},
          finished_at: null,
          nodes: [],
          reason: null,
          run_id: "019cc300-0000-7000-8000-000000000003",
          started_at: "2026-03-14T00:00:00.000Z",
          status: "running",
          workflow_id: "workflow",
        }),
        "utf8",
      )

      const statuses = await readStatuses(projectRoot)
      expect(statuses.map((status) => status.run_id)).toEqual(["019cc300-0000-7000-8000-000000000001"])
    } finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })
})
