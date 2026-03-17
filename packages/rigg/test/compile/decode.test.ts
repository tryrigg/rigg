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

  test("rejects unsupported codex fields and invalid actions", () => {
    const invalidField = decodeWorkflowFile(
      {
        id: "check",
        steps: [
          {
            type: "codex",
            with: {
              action: "run",
              invalid_field: "draft",
              prompt: "hello",
            },
          },
        ],
      },
      "/workspace/.rigg/check.yaml",
    )
    const invalidAction = decodeWorkflowFile(
      {
        id: "check",
        steps: [
          {
            type: "codex",
            with: {
              action: "launch",
              prompt: "hello",
            },
          },
        ],
      },
      "/workspace/.rigg/check.yaml",
    )
    const invalidPlanCombination = decodeWorkflowFile(
      {
        id: "check",
        steps: [
          {
            type: "codex",
            with: {
              action: "plan",
              prompt: "hello",
              review: {
                target: {
                  type: "uncommitted",
                },
              },
            },
          },
        ],
      },
      "/workspace/.rigg/check.yaml",
    )
    const invalidEffort = decodeWorkflowFile(
      {
        id: "check",
        steps: [
          {
            type: "codex",
            with: {
              action: "run",
              effort: "minimal",
              prompt: "hello",
            },
          },
        ],
      },
      "/workspace/.rigg/check.yaml",
    )
    const reviewEffort = decodeWorkflowFile(
      {
        id: "check",
        steps: [
          {
            type: "codex",
            with: {
              action: "review",
              effort: "high",
              review: {
                target: {
                  type: "uncommitted",
                },
              },
            },
          },
        ],
      },
      "/workspace/.rigg/check.yaml",
    )

    expect(invalidField.kind).toBe("invalid_workflow")
    expect(invalidAction.kind).toBe("invalid_workflow")
    expect(invalidPlanCombination.kind).toBe("invalid_workflow")
    expect(invalidEffort.kind).toBe("invalid_workflow")
    expect(reviewEffort.kind).toBe("invalid_workflow")

    if (invalidField.kind === "invalid_workflow") {
      expect(invalidField.error.message).toContain("Workflow schema validation failed.")
    }
    if (invalidAction.kind === "invalid_workflow") {
      expect(invalidAction.error.message).toContain("Workflow schema validation failed.")
    }
    if (invalidPlanCombination.kind === "invalid_workflow") {
      expect(invalidPlanCombination.error.message).toContain("Workflow schema validation failed.")
    }
    if (invalidEffort.kind === "invalid_workflow") {
      expect(invalidEffort.error.message).toContain("Workflow schema validation failed.")
    }
    if (reviewEffort.kind === "invalid_workflow") {
      expect(reviewEffort.error.message).toContain("Workflow schema validation failed.")
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
