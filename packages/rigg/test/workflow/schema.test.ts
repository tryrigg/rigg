import { describe, expect, test } from "bun:test"

import { parseDuration } from "../../src/util/duration"
import type { WorkflowDocument } from "../../src/workflow/schema"
import { RetryConfigSchema, WorkflowDocumentSchema } from "../../src/workflow/schema"

describe("workflow/schema", () => {
  test("WorkflowDocument type accepts numeric retry shorthand", () => {
    const workflow: WorkflowDocument = {
      id: "retry-shorthand",
      steps: [
        {
          id: "retry",
          retry: 3,
          type: "shell",
          with: {
            command: "echo retry",
          },
        },
      ],
    }

    expect(workflow.steps[0]).toMatchObject({
      id: "retry",
      retry: 3,
      type: "shell",
    })
  })

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
        id: "invalid-cursor-stdout",
        steps: [
          {
            type: "cursor",
            with: {
              mode: "agent",
              prompt: "nope",
              stdout: {
                mode: "json",
              },
            },
          },
        ],
      }),
    ).toThrow()
  })

  test("accepts retry shorthand, retry objects, and loop with either termination condition", () => {
    expect(RetryConfigSchema.parse(3)).toEqual({ max: 3 })
    expect(RetryConfigSchema.parse({ delay: "500ms", max: 3 })).toEqual({
      delay: "500ms",
      max: 3,
    })
    expect(
      WorkflowDocumentSchema.parse({
        id: "retry-loop",
        steps: [
          {
            id: "call_child",
            retry: { backoff: 2, delay: "1s", max: 3 },
            type: "workflow",
            with: {
              workflow: "child",
            },
          },
          {
            id: "loop",
            max: 3,
            steps: [
              {
                id: "work",
                retry: 2,
                type: "shell",
                with: {
                  command: "echo hi",
                },
              },
            ],
            type: "loop",
          },
          {
            id: "until_only",
            steps: [
              {
                id: "poll",
                type: "shell",
                with: {
                  command: "echo waiting",
                },
              },
            ],
            type: "loop",
            until: "${{ true }}",
          },
        ],
      }),
    ).toMatchObject({
      id: "retry-loop",
      steps: [
        {
          id: "call_child",
          retry: {
            backoff: 2,
            delay: "1s",
            max: 3,
          },
          type: "workflow",
        },
        {
          id: "loop",
          max: 3,
          type: "loop",
        },
        {
          id: "until_only",
          type: "loop",
          until: "${{ true }}",
        },
      ],
    })
  })

  test("rejects loops without max or until", () => {
    expect(() =>
      WorkflowDocumentSchema.parse({
        id: "invalid-loop",
        steps: [
          {
            id: "loop",
            steps: [
              {
                id: "work",
                type: "shell",
                with: {
                  command: "echo hi",
                },
              },
            ],
            type: "loop",
          },
        ],
      }),
    ).toThrow("`loop` requires at least one termination condition: `max` or `until`")
  })

  test("rejects retry on control-flow nodes", () => {
    expect(() =>
      WorkflowDocumentSchema.parse({
        id: "control-retry",
        steps: [
          {
            id: "group",
            retry: 2,
            steps: [{ type: "shell", with: { command: "echo hi" } }],
            type: "group",
          },
        ],
      }),
    ).toThrow()

    expect(() =>
      WorkflowDocumentSchema.parse({
        id: "loop-retry",
        steps: [
          {
            id: "loop",
            max: 2,
            retry: 2,
            steps: [{ type: "shell", with: { command: "echo hi" } }],
            type: "loop",
          },
        ],
      }),
    ).toThrow()

    expect(() =>
      WorkflowDocumentSchema.parse({
        id: "branch-retry",
        steps: [
          {
            cases: [{ else: true, steps: [] }],
            id: "branch",
            retry: 2,
            type: "branch",
          },
        ],
      }),
    ).toThrow()

    expect(() =>
      WorkflowDocumentSchema.parse({
        id: "parallel-retry",
        steps: [
          {
            branches: [{ id: "left", steps: [{ type: "shell", with: { command: "echo hi" } }] }],
            id: "parallel",
            retry: 2,
            type: "parallel",
          },
        ],
      }),
    ).toThrow()
  })

  test("parses supported duration literals", () => {
    expect(parseDuration("500ms")).toBe(500)
    expect(parseDuration("1s")).toBe(1000)
    expect(parseDuration("2m")).toBe(120000)
    expect(parseDuration("1.5h")).toBe(5400000)
    expect(parseDuration("soon")).toBeNull()
  })
})
