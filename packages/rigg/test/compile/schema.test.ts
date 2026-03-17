import { describe, expect, test } from "bun:test"

import {
  InputSchema,
  WorkflowDocumentSchema,
  childLoopScope,
  childNodePath,
  compareFrameId,
  compareNodePath,
  defaultsForInputs,
  loopIterationFrameId,
  nodePathFileComponent,
  nodePathFromFileComponent,
  shapeFromSchema,
  parallelBranchFrameId,
  resolveInputPathShape,
  rootFrameId,
  rootNodePath,
  validateIdentifier,
  validateInputDefinitions,
  validateInputValue,
} from "../../src/compile/schema"
import { AnyJsonShape, BooleanShape, IntegerShape, StringShape } from "../../src/compile/expr"

describe("compile/schema", () => {
  test("validates identifiers", () => {
    expect(validateIdentifier("valid_name-1", "workflow id", "/tmp/workflow.yaml")).toBeUndefined()
    expect(validateIdentifier("1invalid", "workflow id", "/tmp/workflow.yaml")).toMatchObject({
      code: "invalid_workflow",
      filePath: "/tmp/workflow.yaml",
      message:
        "Invalid workflow id `1invalid`. Identifiers must start with a letter or `_` and only contain ASCII letters, digits, `_`, or `-`.",
    })
  })

  test("round-trips node path file components", () => {
    const nodePath = childNodePath(rootNodePath(12), 3)
    const component = nodePathFileComponent(nodePath)

    expect(component).toBe("s00000002_12s00000001_3")
    expect(nodePathFromFileComponent(component)).toBe("/12/3")
    expect(nodePathFromFileComponent("invalid")).toBeUndefined()
  })

  test("sorts node paths and frame ids numerically", () => {
    expect(["/10", "/2", "/1/1", "/1"].sort(compareNodePath)).toEqual(["/1", "/1/1", "/2", "/10"])

    const loopScope = childLoopScope(rootFrameId(), "/0")
    expect(
      [parallelBranchFrameId("root", "/0", 10), parallelBranchFrameId("root", "/0", 2)].sort(compareFrameId),
    ).toEqual([parallelBranchFrameId("root", "/0", 2), parallelBranchFrameId("root", "/0", 10)])
    expect(loopIterationFrameId(loopScope, 3)).toBe(`${loopScope}.iter.3`)
  })

  test("decodes nullable input schemas", () => {
    expect(
      InputSchema.parse({
        default: "draft",
        type: ["string", "null"],
      }),
    ).toEqual({
      default: "draft",
      nullable: true,
      type: "string",
    })
  })

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

  test("rejects invalid schema structure", () => {
    const objectResult = InputSchema.safeParse({ type: "object" })

    expect(objectResult.success).toBe(false)
    if (!objectResult.success) {
      expect(objectResult.error.issues[0]?.message).toContain("object inputs require `properties`")
    }
  })

  test("validates input definition constraints", () => {
    expect(
      validateInputDefinitions({
        options: {
          properties: {
            format: {
              default: "text",
              type: "string",
            },
          },
          type: "object",
        },
      }),
    ).toEqual(["inputs.options.properties.format cannot define nested defaults"])

    expect(
      validateInputDefinitions({
        text: {
          maxLength: 1,
          minLength: 2,
          type: "string",
        },
      }),
    ).toEqual(["inputs.text has minLength greater than maxLength"])

    expect(
      validateInputDefinitions({
        review: {
          default: "oops",
          properties: {
            accepted: { type: "boolean" },
          },
          required: ["accepted", "missing"],
          type: "object",
        },
      }),
    ).toEqual([
      "inputs.review has invalid `default`: must be an object",
      "inputs.review.required references unknown property `missing`",
    ])

    expect(
      validateInputDefinitions({
        slug: {
          pattern: "[",
          type: "string",
        },
      }),
    ).toEqual([expect.stringContaining("inputs.slug.pattern is not a valid regular expression:")])
  })

  test("validates input values", () => {
    const schema = InputSchema.parse({
      additionalProperties: false,
      properties: {
        retries: {
          minimum: 1,
          type: "integer",
        },
        tags: {
          items: {
            minLength: 2,
            type: "string",
          },
          minItems: 1,
          type: "array",
        },
      },
      required: ["retries", "tags"],
      type: "object",
    })

    expect(validateInputValue(schema, { extra: true }, "inputs.config")).toEqual([
      "inputs.config.retries is required",
      "inputs.config.tags is required",
      "inputs.config.extra is not allowed",
    ])

    expect(validateInputValue(schema, { retries: 0, tags: ["x"] }, "inputs.config")).toEqual([
      "inputs.config.retries must be >= 1",
      "inputs.config.tags.0 must be at least 2 characters",
    ])
  })

  test("collects input defaults using current JSON coercion behavior", () => {
    expect(
      defaultsForInputs({
        mode: {
          default: "safe",
          type: "string",
        },
        metadata: {
          default: new Date("2026-03-14T00:00:00.000Z"),
          type: "string",
        },
      }),
    ).toEqual({
      metadata: {},
      mode: "safe",
    })
  })

  test("derives result shapes from schemas", () => {
    expect(
      shapeFromSchema({
        properties: {
          accepted: { type: "boolean" },
          summary: { nullable: true, type: "string" },
        },
        type: "object",
      }),
    ).toEqual({
      fields: {
        accepted: BooleanShape,
        summary: AnyJsonShape,
      },
      kind: "object",
    })

    expect(
      shapeFromSchema({
        items: { type: "integer" },
        type: "array",
      }),
    ).toEqual({
      items: IntegerShape,
      kind: "array",
    })

    expect(shapeFromSchema({ type: "string" })).toEqual(StringShape)
  })

  test("resolves nested input path shapes", () => {
    expect(
      resolveInputPathShape(
        {
          properties: {
            items: {
              items: {
                properties: {
                  title: { type: "string" },
                },
                required: ["title"],
                type: "object",
              },
              type: "array",
            },
          },
          required: ["items"],
          type: "object",
        },
        "inputs.config",
        ["items", "0", "title"],
      ),
    ).toEqual({ kind: "ok", shape: StringShape })
  })
})
