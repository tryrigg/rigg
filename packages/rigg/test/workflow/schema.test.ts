import { describe, expect, test } from "bun:test"

import { WorkflowDocumentSchema } from "../../src/workflow/schema"

describe("workflow/schema", () => {
  test("accepts codex plan steps in the workflow schema", () => {
    expect(
      WorkflowDocumentSchema.parse({
        id: "plan-step",
        steps: [
          {
            id: "draft_plan",
            type: "codex",
            with: {
              action: "plan",
              prompt: "Clarify requirements and produce a plan.",
            },
          },
        ],
      }),
    ).toEqual({
      id: "plan-step",
      steps: [
        {
          id: "draft_plan",
          type: "codex",
          with: {
            action: "plan",
            prompt: "Clarify requirements and produce a plan.",
          },
        },
      ],
    })
  })

  test("accepts codex prompt steps with effort overrides", () => {
    expect(
      WorkflowDocumentSchema.parse({
        id: "effort-step",
        steps: [
          {
            id: "implement",
            type: "codex",
            with: {
              action: "run",
              effort: "high",
              prompt: "Implement the feature.",
            },
          },
          {
            id: "draft_plan",
            type: "codex",
            with: {
              action: "plan",
              effort: "low",
              prompt: "Produce a plan.",
            },
          },
        ],
      }),
    ).toEqual({
      id: "effort-step",
      steps: [
        {
          id: "implement",
          type: "codex",
          with: {
            action: "run",
            effort: "high",
            prompt: "Implement the feature.",
          },
        },
        {
          id: "draft_plan",
          type: "codex",
          with: {
            action: "plan",
            effort: "low",
            prompt: "Produce a plan.",
          },
        },
      ],
    })
  })
})
