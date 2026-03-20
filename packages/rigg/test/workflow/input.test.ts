import { describe, expect, test } from "bun:test"

import { InputSchema, defaults, checkDefs, checkValue } from "../../src/workflow/input"

describe("workflow/input", () => {
  test("rejects nullable input schemas", () => {
    const result = InputSchema.safeParse({
      default: "draft",
      type: ["string", "null"],
    })

    expect(result.success).toBe(false)
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
      checkDefs({
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
      checkDefs({
        text: {
          maxLength: 1,
          minLength: 2,
          type: "string",
        },
      }),
    ).toEqual(["inputs.text has minLength greater than maxLength"])

    expect(
      checkDefs({
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
      checkDefs({
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

    expect(checkValue(schema, { extra: true }, "inputs.config")).toEqual([
      "inputs.config.retries is required",
      "inputs.config.tags is required",
      "inputs.config.extra is not allowed",
    ])

    expect(checkValue(schema, { retries: 0, tags: ["x"] }, "inputs.config")).toEqual([
      "inputs.config.retries must be >= 1",
      "inputs.config.tags.0 must be at least 2 characters",
    ])

    expect(checkValue({ type: "string" }, null, "inputs.note")).toEqual(["inputs.note must not be null"])
  })

  test("collects input defaults using current JSON coercion behavior", () => {
    expect(
      defaults({
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
})
