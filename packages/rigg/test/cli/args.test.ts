import { describe, expect, test } from "bun:test"

import { parseCommand } from "../../src/cli/args"

describe("cli/args", () => {
  test("rejects extra positional arguments for logs", () => {
    expect(parseCommand(["logs", "run-id", "step-id", "extra"])).toEqual({
      kind: "invalid",
      message: "Unexpected logs argument: extra",
    })
  })

  test("rejects missing values for logs options when the next token is another flag", () => {
    expect(parseCommand(["logs", "--run", "--json"])).toEqual({
      kind: "invalid",
      message: "`rigg logs --run` requires a run id.",
    })

    expect(parseCommand(["logs", "--step", "--json"])).toEqual({
      kind: "invalid",
      message: "`rigg logs --step` requires a step id.",
    })
  })

  test("rejects malformed history pagination values", () => {
    expect(parseCommand(["history", "--limit", "1foo"])).toEqual({
      kind: "invalid",
      message: "`rigg history --limit` requires a non-negative integer.",
    })

    expect(parseCommand(["history", "--offset", "1.5"])).toEqual({
      kind: "invalid",
      message: "`rigg history --offset` requires a non-negative integer.",
    })

    expect(parseCommand(["history", "--limit", "1e2"])).toEqual({
      kind: "invalid",
      message: "`rigg history --limit` requires a non-negative integer.",
    })
  })
})
