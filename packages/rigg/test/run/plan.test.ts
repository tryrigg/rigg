import { describe, expect, test } from "bun:test"

import { normalizeInvocationInputs } from "../../src/run/plan"
import type { WorkflowDocument } from "../../src/compile/schema"

describe("run/plan", () => {
  test("rejects missing required input", () => {
    const workflow: WorkflowDocument = {
      id: "review",
      inputs: {
        requirements: {
          type: "string",
        },
      },
      steps: [{ type: "shell", with: { command: "echo hi" } }],
    }

    expect(normalizeInvocationInputs(workflow, {})).toEqual({
      errors: ["inputs.requirements is required"],
      kind: "invalid",
    })
  })

  test("applies defaults before validating", () => {
    const workflow: WorkflowDocument = {
      id: "review",
      inputs: {
        requirements: {
          default: "fallback",
          type: "string",
        },
      },
      steps: [{ type: "shell", with: { command: "echo hi" } }],
    }

    expect(normalizeInvocationInputs(workflow, {})).toEqual({
      inputs: { requirements: "fallback" },
      kind: "valid",
    })
  })

  test("rejects undeclared inputs and constraint violations", () => {
    const workflow: WorkflowDocument = {
      id: "review",
      inputs: {
        requirements: {
          items: { type: "string" },
          minItems: 1,
          type: "array",
        },
      },
      steps: [{ type: "shell", with: { command: "echo hi" } }],
    }

    expect(normalizeInvocationInputs(workflow, { extra: true, requirements: [] })).toEqual({
      errors: ["inputs.requirements must contain at least 1 item(s)", "inputs.extra is not declared"],
      kind: "invalid",
    })
  })
})
