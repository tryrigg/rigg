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

  test("accepts cursor action steps", () => {
    expect(
      WorkflowDocumentSchema.parse({
        id: "cursor-step",
        steps: [
          {
            id: "draft_plan",
            type: "cursor",
            with: {
              action: "plan",
              prompt: "Clarify requirements and produce a plan.",
            },
          },
          {
            id: "ask_followup",
            type: "cursor",
            with: {
              action: "ask",
              prompt: "Ask a concise question.",
            },
          },
        ],
      }),
    ).toEqual({
      id: "cursor-step",
      steps: [
        {
          id: "draft_plan",
          type: "cursor",
          with: {
            action: "plan",
            prompt: "Clarify requirements and produce a plan.",
          },
        },
        {
          id: "ask_followup",
          type: "cursor",
          with: {
            action: "ask",
            prompt: "Ask a concise question.",
          },
        },
      ],
    })
  })

  test("rejects provider-specific invalid actions", () => {
    expect(() =>
      WorkflowDocumentSchema.parse({
        id: "invalid-actions",
        steps: [
          {
            type: "cursor",
            with: {
              action: "review",
              prompt: "nope",
            },
          },
        ],
      }),
    ).toThrow()

    expect(() =>
      WorkflowDocumentSchema.parse({
        id: "invalid-codex-action",
        steps: [
          {
            type: "codex",
            with: {
              action: "ask",
              prompt: "nope",
            },
          },
        ],
      }),
    ).toThrow()

    expect(() =>
      WorkflowDocumentSchema.parse({
        id: "invalid-cursor-result",
        steps: [
          {
            type: "cursor",
            with: {
              action: "run",
              prompt: "nope",
              result: "json",
            },
          },
        ],
      }),
    ).toThrow()
  })
})
