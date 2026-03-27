import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"

import { renderErrors, renderSummary, writeLines } from "../../src/cli/out"
import { workflowProject } from "../fixture/builders"

describe("cli/out", () => {
  test("renders compile errors with file locations", () => {
    expect(
      renderErrors([
        {
          code: "invalid_workflow",
          filePath: "/workspace/.rigg/review.yaml",
          message: "Invalid workflow",
        },
        {
          code: "project_not_found",
          message: "Missing .rigg directory",
        },
      ]),
    ).toEqual([
      "invalid_workflow [/workspace/.rigg/review.yaml]: Invalid workflow",
      "project_not_found: Missing .rigg directory",
    ])
  })

  test("renders annotated diagnostics with line, snippet, and hints", () => {
    expect(
      renderErrors([
        {
          code: "invalid_workflow",
          column: 7,
          filePath: "/workspace/.rigg/review.yaml",
          hints: ["Use `1` for a fixed delay or a larger multiplier for exponential backoff."],
          line: 12,
          message: "`retry.backoff` must be between 1 and 10",
          snippet: "      backoff: 0.5",
        },
      ]),
    ).toEqual([
      "invalid_workflow: `retry.backoff` must be between 1 and 10",
      "  --> /workspace/.rigg/review.yaml:12:7",
      "   |",
      "12 |       backoff: 0.5",
      "   |       ^",
      "   = hint: Use `1` for a fixed delay or a larger multiplier for exponential backoff.",
    ])
  })

  test("renders workflow summaries in id order", () => {
    expect(
      renderSummary(
        workflowProject([
          {
            workflow: {
              id: "review",
              steps: [{ type: "shell", with: { command: "echo hi" } }],
            },
          },
          {
            workflow: {
              id: "draft",
              steps: [{ type: "shell", with: { command: "echo hi" } }],
            },
          },
        ]),
      ),
    ).toEqual(["Discovered 2 workflow file(s) in /workspace/.rigg.", "- draft", "- review"])
  })

  test("writes lines only when there is content", async () => {
    const stream = new PassThrough()
    let output = ""
    stream.setEncoding("utf8")
    stream.on("data", (chunk) => {
      output += chunk
    })

    writeLines([], stream as unknown as NodeJS.WriteStream)
    writeLines(["one", "two"], stream as unknown as NodeJS.WriteStream)
    stream.end()

    await new Promise<void>((resolve) => {
      stream.on("end", () => resolve())
    })

    expect(output).toBe("one\ntwo\n")
  })
})
