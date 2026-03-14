import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { eventsPath } from "../../src/history/fs"
import { appendEvent, createRunRecorder } from "../../src/run/record"

describe("run/record", () => {
  test("writes events.jsonl as one compact JSON object per line", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-record-"))

    try {
      const recorder = await createRunRecorder(root, "123e4567-e89b-12d3-a456-426614174000", {
        configFiles: [],
        configHash: "hash",
        cwd: root,
        invocationInputs: {},
        startedAt: "2026-03-14T00:00:00.000Z",
        toolVersion: "0.0.0",
        workflowId: "workflow",
      })

      await appendEvent(recorder, { kind: "one", nested: { answer: 42 } })
      await appendEvent(recorder, { kind: "two", message: "hello" })

      const lines = (await readFile(eventsPath(root, recorder.runId), "utf8")).trimEnd().split("\n")
      expect(lines).toHaveLength(2)
      expect(lines.map((line) => JSON.parse(line))).toEqual([
        { kind: "one", nested: { answer: 42 } },
        { kind: "two", message: "hello" },
      ])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
