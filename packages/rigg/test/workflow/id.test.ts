import { describe, expect, test } from "bun:test"

import {
  childPath,
  compareFrame,
  comparePath,
  loopFrame,
  loopScope,
  parallelFrame,
  rootFrame,
  rootPath,
  checkIdent,
} from "../../src/workflow/id"

describe("workflow/id", () => {
  test("validates identifiers", () => {
    expect(checkIdent("valid_name-1", "workflow id", "/tmp/workflow.yaml")).toBeUndefined()
    expect(checkIdent("1invalid", "workflow id", "/tmp/workflow.yaml")).toMatchObject({
      code: "invalid_workflow",
      filePath: "/tmp/workflow.yaml",
      message:
        "Invalid workflow id `1invalid`. Identifiers must start with a letter or `_` and only contain ASCII letters, digits, `_`, or `-`.",
    })
  })

  test("builds node paths", () => {
    expect(childPath(rootPath(12), 3)).toBe("/12/3")
  })

  test("sorts node paths and frame ids numerically", () => {
    expect(["/10", "/2", "/1/1", "/1"].sort(comparePath)).toEqual(["/1", "/1/1", "/2", "/10"])

    const loopScopeVal = loopScope(rootFrame(), "/0")
    expect([parallelFrame("root", "/0", 10), parallelFrame("root", "/0", 2)].sort(compareFrame)).toEqual([
      parallelFrame("root", "/0", 2),
      parallelFrame("root", "/0", 10),
    ])
    expect(loopFrame(loopScopeVal, 3)).toBe(`${loopScopeVal}.iter.3`)
  })
})
