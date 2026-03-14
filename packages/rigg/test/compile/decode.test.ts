import { describe, expect, test } from "bun:test"

import { decodeWorkflowFile } from "../../src/compile/decode"
import { parseYamlDocument } from "../../src/compile/syntax"

describe("compile/decode", () => {
  test("parses valid YAML documents", () => {
    expect(
      parseYamlDocument(
        `
id: check
steps:
  - type: shell
    with:
      command: echo hi
`,
        "/workspace/.rigg/check.yaml",
      ),
    ).toEqual({
      document: {
        id: "check",
        steps: [{ type: "shell", with: { command: "echo hi" } }],
      },
      kind: "parsed",
    })
  })

  test("reports invalid YAML documents", () => {
    const result = parseYamlDocument("id: [broken", "/workspace/.rigg/broken.yaml")

    expect(result.kind).toBe("invalid_yaml")
    if (result.kind === "invalid_yaml") {
      expect(result.error).toMatchObject({
        code: "invalid_yaml",
        filePath: "/workspace/.rigg/broken.yaml",
        message: "Failed to parse workflow YAML.",
      })
      expect(result.error.cause).toBeInstanceOf(Error)
    }
  })

  test("decodes valid workflow files", () => {
    expect(
      decodeWorkflowFile(
        {
          id: "check",
          steps: [
            {
              type: "shell",
              with: {
                command: "echo hi",
              },
            },
          ],
        },
        "/workspace/.rigg/check.yaml",
      ),
    ).toEqual({
      kind: "decoded",
      workflow: {
        id: "check",
        steps: [{ type: "shell", with: { command: "echo hi" } }],
      },
    })
  })

  test("rejects unknown keys and missing required fields", () => {
    const unknownKey = decodeWorkflowFile(
      {
        id: "check",
        steps: [
          {
            type: "shell",
            unknown: true,
            with: {
              command: "echo hi",
            },
          },
        ],
      },
      "/workspace/.rigg/check.yaml",
    )
    const missingRequired = decodeWorkflowFile({ id: "check" }, "/workspace/.rigg/check.yaml")

    expect(unknownKey.kind).toBe("invalid_workflow")
    expect(missingRequired.kind).toBe("invalid_workflow")

    if (unknownKey.kind === "invalid_workflow") {
      expect(unknownKey.error.code).toBe("invalid_workflow")
      expect(unknownKey.error.message).toContain("Workflow schema validation failed.")
      expect(unknownKey.error.message).toContain("steps.0")
    }
    if (missingRequired.kind === "invalid_workflow") {
      expect(missingRequired.error.message).toContain("steps")
    }
  })

  test("rejects invalid workflow identifiers", () => {
    const result = decodeWorkflowFile(
      {
        id: "1invalid",
        steps: [
          {
            type: "shell",
            with: {
              command: "echo hi",
            },
          },
        ],
      },
      "/workspace/.rigg/check.yaml",
    )

    expect(result).toMatchObject({
      error: {
        code: "invalid_workflow",
        filePath: "/workspace/.rigg/check.yaml",
        message:
          "Invalid workflow id `1invalid`. Identifiers must start with a letter or `_` and only contain ASCII letters, digits, `_`, or `-`.",
      },
      kind: "invalid_workflow",
    })
  })
})
