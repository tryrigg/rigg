import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"

import { renderCompileErrors, renderWorkflowSummary, writeLines } from "../../src/cli/output"
import { workflowProject } from "../fixture/builders"

describe("cli/output", () => {
  test("renders compile errors with file locations", () => {
    expect(
      renderCompileErrors([
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

  test("renders workflow summaries in id order", () => {
    expect(
      renderWorkflowSummary(
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
