import { describe, expect, test } from "bun:test"

import {
  compile,
  extractExprs,
  inferExpressionResultShape,
  isWholeTemplate,
  renderTemplate,
  renderString,
  type EvalContext,
} from "../../src/workflow/expr"
import {
  AnyJsonShape,
  BooleanShape,
  IntegerShape,
  NumberShape,
  StringShape,
  mergeShapes,
  shapeFromJson,
} from "../../src/workflow/shape"

const context = {
  env: { CI: "true", EMPTY: undefined },
  inputs: {
    config: { timeout: 30 },
    flags: ["alpha", "beta"],
    json_text: '{"ok":true}',
    name: "Rigg",
  },
  run: { iteration: 2, max_iterations: 5, node_path: "/0/1" },
  steps: {
    check: {
      result: {
        count: 2,
        done: false,
        nested: [{ path: "src/index.ts" }],
        tags: ["bug", "docs"],
      },
      status: "succeeded",
    },
  },
} as const

const composedAccent = "é"
const decomposedAccent = "e\u0301"
const unicodeObject = {
  [composedAccent]: "composed",
  [decomposedAccent]: "decomposed",
}
const unicodeObjectReordered = {
  [decomposedAccent]: "decomposed",
  [composedAccent]: "composed",
}
const unicodeContext = {
  ...context,
  inputs: {
    ...context.inputs,
    composedAccent,
    decomposedAccent,
    haystack: [unicodeObject],
    needle: unicodeObjectReordered,
    unicodeObject,
    unicodeObjectReordered,
  },
}

function evalExpr(expression: string, ctx: EvalContext): unknown {
  return renderTemplate("${{ " + expression + " }}", ctx)
}

describe("workflow/expr", () => {
  test("extracts template expressions in order", () => {
    expect(extractExprs("Hello ${{ inputs.name }} from ${{ env.CI }}")).toEqual(["inputs.name", "env.CI"])
  })

  test("detects whole-expression templates and unwraps them", () => {
    expect(isWholeTemplate("${{ steps.check.result.count }}")).toBe(true)
    expect(isWholeTemplate("prefix ${{ steps.check.result.count }}")).toBe(false)
    const t = "  ${{ steps.check.result.count }}  "
    expect(isWholeTemplate(t) ? extractExprs(t.trim())[0] : undefined).toBe("steps.check.result.count")
  })

  for (const testCase of [
    {
      expression: "inputs.name",
      expected: "Rigg",
      name: "reads input paths",
    },
    {
      expression: "inputs.config.timeout",
      expected: 30,
      name: "reads nested object paths",
    },
    {
      expression: "steps.check.result.nested.0.path",
      expected: "src/index.ts",
      name: "reads array indices from step results",
    },
    {
      expression: "env.EMPTY",
      expected: null,
      name: "normalizes missing env values to null",
    },
    {
      expression: "1 < 2 || false && false",
      expected: true,
      name: "applies operator precedence",
    },
    {
      expression: "(1 < 2 || false) && false",
      expected: false,
      name: "supports parentheses",
    },
    {
      expression: "format('{0}:{1}', inputs.name, run.iteration)",
      expected: "Rigg:2",
      name: "formats strings",
    },
    {
      expression: "join(steps.check.result.tags, ', ')",
      expected: "bug, docs",
      name: "joins arrays",
    },
    {
      expression: "len(steps.check.result.tags)",
      expected: 2,
      name: "counts array items",
    },
    {
      expression: "toJSON(steps.check.result)",
      expected: '{"count":2,"done":false,"nested":[{"path":"src/index.ts"}],"tags":["bug","docs"]}',
      name: "serializes JSON",
    },
    {
      expression: "fromJSON(inputs.json_text)",
      expected: { ok: true },
      name: "parses JSON strings",
    },
  ]) {
    test(testCase.name, () => {
      expect(evalExpr(testCase.expression, context)).toEqual(testCase.expected)
    })
  }

  test("renders mixed literal and scalar expressions", () => {
    expect(renderTemplate("Hello ${{ inputs.name }} #${{ run.iteration }}", context)).toBe("Hello Rigg #2")
    expect(renderString("Hello ${{ inputs.name }} #${{ run.iteration }}", context)).toBe("Hello Rigg #2")
  })

  test("uses strict string equality for canonically distinct unicode strings", () => {
    expect(evalExpr("inputs.composedAccent == inputs.decomposedAccent", unicodeContext)).toBe(false)
    expect(evalExpr("inputs.composedAccent != inputs.decomposedAccent", unicodeContext)).toBe(true)
  })

  test("returns structured values for whole-expression templates", () => {
    expect(renderTemplate("${{ steps.check.result }}", context)).toEqual(context.steps.check.result)
    expect(renderString("${{ steps.check.result }}", context)).toBe(
      '{"count":2,"done":false,"nested":[{"path":"src/index.ts"}],"tags":["bug","docs"]}',
    )
  })

  test("rejects non-scalar expressions inside interpolated strings", () => {
    expect(() => renderString("Findings: ${{ steps.check.result.tags }}", context)).toThrow(
      "evaluated to non-scalar template value",
    )
  })

  test("canonicalizes JSON object keys independent of insertion order", () => {
    expect(evalExpr("toJSON(inputs.unicodeObject)", unicodeContext)).toBe('{"e\u0301":"decomposed","é":"composed"}')
    expect(evalExpr("toJSON(inputs.unicodeObject)", unicodeContext)).toBe(
      evalExpr("toJSON(inputs.unicodeObjectReordered)", unicodeContext),
    )
  })

  test("contains matches objects by canonical JSON shape", () => {
    expect(evalExpr("contains(inputs.haystack, inputs.needle)", unicodeContext)).toBe(true)
  })

  test("captures expression metadata and infers result shapes", () => {
    const expression = compile("steps.check.result.count >= run.iteration")

    expect(expression.directPathReference).toBeUndefined()
    expect([...expression.roots]).toEqual(["steps", "run"])
    expect(expression.pathReferences).toEqual([
      { root: "steps", segments: ["check", "result", "count"] },
      { root: "run", segments: ["iteration"] },
    ])

    const shape = inferExpressionResultShape(expression, () => IntegerShape)

    expect(shape).toEqual(BooleanShape)
  })

  test("infers shapes from JSON values", () => {
    expect(shapeFromJson("text")).toEqual(StringShape)
    expect(shapeFromJson(1)).toEqual(IntegerShape)
    expect(shapeFromJson(1.5)).toEqual(NumberShape)
    expect(shapeFromJson({ ok: true })).toEqual({
      fields: { ok: BooleanShape },
      kind: "object",
    })
    expect(shapeFromJson([{ path: "a" }, { path: "b" }])).toEqual({
      items: {
        fields: { path: StringShape },
        kind: "object",
      },
      kind: "array",
    })
  })

  test("merges compatible and incompatible result shapes", () => {
    expect(mergeShapes(IntegerShape, NumberShape)).toEqual(NumberShape)
    expect(mergeShapes({ kind: "array", items: IntegerShape }, { kind: "array", items: NumberShape })).toEqual({
      kind: "array",
      items: NumberShape,
    })
    expect(
      mergeShapes(
        { kind: "object", fields: { count: IntegerShape } },
        { kind: "object", fields: { count: IntegerShape } },
      ),
    ).toEqual({ kind: "object", fields: { count: IntegerShape } })
    expect(
      mergeShapes(
        { kind: "object", fields: { count: IntegerShape } },
        { kind: "object", fields: { total: IntegerShape } },
      ),
    ).toEqual(AnyJsonShape)
  })
})
