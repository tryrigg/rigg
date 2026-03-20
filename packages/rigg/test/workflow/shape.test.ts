import { describe, expect, test } from "bun:test"

import {
  AnyJsonShape,
  BooleanShape,
  IntegerShape,
  StringShape,
  resolveInputPath,
  shapeFromSchema,
} from "../../src/workflow/shape"

describe("workflow/shape", () => {
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
      resolveInputPath(
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
