import { describe, expect, test } from "bun:test"

import { decodeRunSnapshot } from "../../src/history/decode"
import { runSnapshot } from "../fixture/builders"

describe("history/decode", () => {
  test("decodes valid run snapshots", () => {
    expect(
      decodeRunSnapshot(
        runSnapshot({
          nodes: [
            {
              attempt: 1,
              duration_ms: null,
              exit_code: null,
              finished_at: null,
              node_path: "/0",
              result: null,
              started_at: null,
              status: "pending",
              stderr: null,
              stderr_path: null,
              stderr_preview: "",
              stdout: null,
              stdout_path: null,
              stdout_preview: "",
              user_id: null,
            },
          ],
        }),
        "/workspace/.rigg/runs/run-1/state.json",
      ),
    ).toEqual(
      runSnapshot({
        nodes: [
          {
            attempt: 1,
            duration_ms: null,
            exit_code: null,
            finished_at: null,
            node_path: "/0",
            result: null,
            started_at: null,
            status: "pending",
            stderr: null,
            stderr_path: null,
            stderr_preview: "",
            stdout: null,
            stdout_path: null,
            stdout_preview: "",
            user_id: null,
          },
        ],
      }),
    )
  })

  test("throws compile-style errors for invalid snapshots", () => {
    try {
      decodeRunSnapshot(
        { run_id: "run-1", started_at: "2026-03-14T00:00:00.000Z", workflow_id: "workflow" },
        "state.json",
      )
      throw new Error("expected decodeRunSnapshot to throw")
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid_workflow",
        filePath: "state.json",
      })
    }
  })
})
