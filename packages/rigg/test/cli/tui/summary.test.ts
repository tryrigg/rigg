import { describe, expect, test } from "bun:test"

import { countStatuses, summaryRunId } from "../../../src/cli/tui/summary"
import type { TreeEntry } from "../../../src/cli/tui/tree"

function treeEntry(overrides: Partial<TreeEntry>): TreeEntry {
  return {
    depth: 0,
    entryType: "step",
    isActive: false,
    isNext: false,
    label: "step",
    nodeKind: "shell",
    nodePath: "/0",
    prefix: "",
    status: "not_started",
    suffix: "",
    ...overrides,
  }
}

describe("cli/tui/summary", () => {
  test("counts failed control nodes in the final summary", () => {
    const counts = countStatuses([
      treeEntry({ nodeKind: "shell", status: "succeeded" }),
      treeEntry({ nodeKind: "group", nodePath: "/1", status: "failed" }),
      treeEntry({ nodeKind: "parallel", nodePath: "/2", status: "skipped" }),
      treeEntry({ nodeKind: "loop", nodePath: "/3", status: "interrupted" }),
      treeEntry({ nodeKind: "branch_case", nodePath: "/4", status: "failed" }),
    ])

    expect(counts).toEqual({
      failedCount: 1,
      failedSteps: [{ label: "step", suffix: "" }],
      interruptedCount: 1,
      skippedCount: 1,
      succeededCount: 1,
    })
  })

  test("formats the run id footer with the full copyable id", () => {
    expect(summaryRunId("d3f8a1c4-9e2b-4f7a-8d1c-3e5f7a9b2c4d")).toBe("run d3f8a1c49e2b4f7a8d1c3e5f7a9b2c4d")
  })
})
