import { describe, expect, test } from "bun:test"

import { countSummaryStatuses } from "../../../src/cli/tui/summary"
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
    const counts = countSummaryStatuses([
      treeEntry({ nodeKind: "shell", status: "succeeded" }),
      treeEntry({ nodeKind: "group", nodePath: "/1", status: "failed" }),
      treeEntry({ nodeKind: "parallel", nodePath: "/2", status: "skipped" }),
      treeEntry({ nodeKind: "loop", nodePath: "/3", status: "interrupted" }),
      treeEntry({ nodeKind: "branch_case", nodePath: "/4", status: "failed" }),
    ])

    expect(counts).toEqual({
      failedCount: 1,
      interruptedCount: 1,
      skippedCount: 1,
      succeededCount: 1,
    })
  })
})
