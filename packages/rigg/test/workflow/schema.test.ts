import { describe, expect, test } from "bun:test"

import { WorkflowDocumentSchema } from "../../src/workflow/schema"

describe("workflow/schema", () => {
  test("accepts codex plan collaboration turns in the workflow schema", () => {
    expect(
      WorkflowDocumentSchema.parse({
        id: "plan-step",
        steps: [
          {
            id: "draft_plan",
            type: "codex",
            with: {
              kind: "turn",
              collaboration_mode: "plan",
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
            kind: "turn",
            collaboration_mode: "plan",
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
              kind: "turn",
              effort: "high",
              prompt: "Implement the feature.",
            },
          },
          {
            id: "draft_plan",
            type: "codex",
            with: {
              kind: "turn",
              collaboration_mode: "plan",
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
            kind: "turn",
            effort: "high",
            prompt: "Implement the feature.",
          },
        },
        {
          id: "draft_plan",
          type: "codex",
          with: {
            kind: "turn",
            collaboration_mode: "plan",
            effort: "low",
            prompt: "Produce a plan.",
          },
        },
      ],
    })
  })

  test("accepts cursor mode steps", () => {
    expect(
      WorkflowDocumentSchema.parse({
        id: "cursor-step",
        steps: [
          {
            id: "draft_plan",
            type: "cursor",
            with: {
              mode: "plan",
              prompt: "Clarify requirements and produce a plan.",
            },
          },
          {
            id: "ask_followup",
            type: "cursor",
            with: {
              mode: "ask",
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
            mode: "plan",
            prompt: "Clarify requirements and produce a plan.",
          },
        },
        {
          id: "ask_followup",
          type: "cursor",
          with: {
            mode: "ask",
            prompt: "Ask a concise question.",
          },
        },
      ],
    })
  })

  test("rejects provider-specific invalid modes and unknown keys", () => {
    expect(() =>
      WorkflowDocumentSchema.parse({
        id: "invalid-actions",
        steps: [
          {
            type: "cursor",
            with: {
              mode: "review",
              prompt: "nope",
            },
          },
        ],
      }),
    ).toThrow()

    expect(() =>
      WorkflowDocumentSchema.parse({
        id: "invalid-codex-kind",
        steps: [
          {
            type: "codex",
            with: {
              kind: "ask",
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
              mode: "agent",
              prompt: "nope",
              result: "json",
            },
          },
        ],
      }),
    ).toThrow()
  })
})
