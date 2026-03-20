import { describe, expect, test } from "bun:test"

import { formatElapsed, runDurationMs } from "../../../src/cli/tui/time"
import { runSnapshot } from "../../fixture/builders"

describe("tui/time", () => {
  test("derives run duration from wall-clock timestamps instead of summing nodes", () => {
    const snapshot = runSnapshot({
      finished_at: "2026-03-15T10:00:01.000Z",
      nodes: [
        {
          attempt: 1,
          duration_ms: 1000,
          exit_code: null,
          finished_at: "2026-03-15T10:00:01.000Z",
          node_kind: "group",
          node_path: "/0",
          result: null,
          started_at: "2026-03-15T10:00:00.000Z",
          status: "succeeded",
          stderr: null,
          stdout: null,
          user_id: "group",
          waiting_for: null,
        },
        {
          attempt: 1,
          duration_ms: 1000,
          exit_code: 0,
          finished_at: "2026-03-15T10:00:01.000Z",
          node_kind: "shell",
          node_path: "/0/0",
          result: null,
          started_at: "2026-03-15T10:00:00.000Z",
          status: "succeeded",
          stderr: null,
          stdout: "done",
          user_id: "inner",
          waiting_for: null,
        },
      ],
      started_at: "2026-03-15T10:00:00.000Z",
      status: "succeeded",
    })

    expect(runDurationMs(snapshot)).toBe(1000)
  })

  test("uses finished_at when available for elapsed labels", () => {
    expect(formatElapsed("2026-03-15T10:00:00.000Z", "2026-03-15T10:01:05.000Z")).toBe("01:05")
  })

  test("uses current time for active runs", () => {
    expect(formatElapsed("2026-03-15T10:00:00.000Z", null, Date.parse("2026-03-15T10:00:42.000Z"))).toBe("00:42")
  })
})
