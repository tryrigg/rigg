import { describe, expect, test } from "bun:test"

import { parseCommand } from "../../src/cli/args"

describe("cli/args", () => {
  test("parses headless run flags", () => {
    expect(parseCommand(["run", "plan", "--headless"])).toEqual({
      autoContinue: false,
      inputs: [],
      kind: "run",
      mode: { kind: "headless_text", verbose: false },
      workflowId: "plan",
    })

    expect(parseCommand(["run", "plan", "--headless", "--output-format", "json"])).toEqual({
      autoContinue: false,
      inputs: [],
      kind: "run",
      mode: { kind: "headless_json" },
      workflowId: "plan",
    })

    expect(parseCommand(["run", "plan", "--headless", "--output-format", "stream-json"])).toEqual({
      autoContinue: false,
      inputs: [],
      kind: "run",
      mode: { kind: "headless_stream_json" },
      workflowId: "plan",
    })

    expect(parseCommand(["run", "plan", "--headless", "--verbose"])).toEqual({
      autoContinue: false,
      inputs: [],
      kind: "run",
      mode: { kind: "headless_text", verbose: true },
      workflowId: "plan",
    })
  })

  test("rejects extra positional arguments for run", () => {
    expect(parseCommand(["run", "plan", "extra"])).toEqual({
      kind: "invalid",
      message: "Unexpected run argument: extra",
    })
  })

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

  test("rejects missing values for shared option readers", () => {
    expect(parseCommand(["serve", "--host", "--json"])).toEqual({
      kind: "invalid",
      message: "`rigg serve --host` requires a host.",
    })

    expect(parseCommand(["history", "--status", "--json"])).toEqual({
      kind: "invalid",
      message: "`rigg history --status` requires one of: running, succeeded, failed, aborted.",
    })

    expect(parseCommand(["run", "--input"])).toEqual({
      kind: "invalid",
      message: "`rigg run --input` requires a following KEY=VALUE argument.",
    })
  })

  test("parses serve flags", () => {
    expect(parseCommand(["serve"])).toEqual({
      host: "127.0.0.1",
      json: false,
      kind: "serve",
      port: 3000,
    })

    expect(parseCommand(["serve", "--port", "4000"])).toEqual({
      host: "127.0.0.1",
      json: false,
      kind: "serve",
      port: 4000,
    })

    expect(parseCommand(["serve", "--host", "0.0.0.0", "--json"])).toEqual({
      host: "0.0.0.0",
      json: true,
      kind: "serve",
      port: 3000,
    })
  })

  test("rejects invalid serve flags", () => {
    expect(parseCommand(["serve", "--port", "nope"])).toEqual({
      kind: "invalid",
      message: "`rigg serve --port` requires a non-negative integer.",
    })

    expect(parseCommand(["serve", "--wat"])).toEqual({
      kind: "invalid",
      message: "Unknown serve option: --wat",
    })
  })

  test("rejects invalid headless run combinations", () => {
    expect(parseCommand(["run", "plan", "--output-format"])).toEqual({
      kind: "invalid",
      message: "`rigg run --output-format` requires one of: text, json, stream-json.",
    })

    expect(parseCommand(["run", "plan", "--output-format", "yaml"])).toEqual({
      kind: "invalid",
      message: "`rigg run --output-format` must be one of: text, json, stream-json.",
    })

    expect(parseCommand(["run", "plan", "--output-format", "json"])).toEqual({
      kind: "invalid",
      message: "`--output-format` requires `--headless`.",
    })

    expect(parseCommand(["run", "plan", "--verbose"])).toEqual({
      kind: "invalid",
      message: "`--verbose` requires `--headless`.",
    })

    expect(parseCommand(["run", "plan", "--headless", "--output-format", "json", "--verbose"])).toEqual({
      kind: "invalid",
      message: "`--verbose` is only supported with `--output-format text`.",
    })
  })
})
