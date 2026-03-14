import { describe, expect, test } from "bun:test"

import {
  AnyJsonShape,
  BooleanShape,
  IntegerShape,
  NumberShape,
  StringShape,
  compileExpression,
  evaluateExpression,
  extractTemplateExpressions,
  inferExpressionResultShape,
  isWholeExpressionTemplate,
  mergeResultShapes,
  renderTemplate,
  renderTemplateString,
  resultShapeFromJsonValue,
  unwrapWholeExpressionTemplate,
} from "../../src/compile/expr"

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

describe("compile/expr", () => {
  test("extracts template expressions in order", () => {
    expect(extractTemplateExpressions("Hello ${{ inputs.name }} from ${{ env.CI }}")).toEqual(["inputs.name", "env.CI"])
  })

  test("detects whole-expression templates and unwraps them", () => {
    expect(isWholeExpressionTemplate("${{ steps.check.result.count }}")).toBe(true)
    expect(isWholeExpressionTemplate("prefix ${{ steps.check.result.count }}")).toBe(false)
    expect(unwrapWholeExpressionTemplate("  ${{ steps.check.result.count }}  ")).toBe("steps.check.result.count")
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
      expect(evaluateExpression(testCase.expression, context)).toEqual(testCase.expected)
    })
  }

  test("renders mixed literal and scalar expressions", () => {
    expect(renderTemplate("Hello ${{ inputs.name }} #${{ run.iteration }}", context)).toBe("Hello Rigg #2")
    expect(renderTemplateString("Hello ${{ inputs.name }} #${{ run.iteration }}", context)).toBe("Hello Rigg #2")
  })

  test("returns structured values for whole-expression templates", () => {
    expect(renderTemplate("${{ steps.check.result }}", context)).toEqual(context.steps.check.result)
    expect(renderTemplateString("${{ steps.check.result }}", context)).toBe(
      '{"count":2,"done":false,"nested":[{"path":"src/index.ts"}],"tags":["bug","docs"]}',
    )
  })

  test("rejects non-scalar expressions inside interpolated strings", () => {
    expect(() => renderTemplateString("Findings: ${{ steps.check.result.tags }}", context)).toThrow(
      "evaluated to non-scalar template value",
    )
  })

  test("captures expression metadata and infers result shapes", () => {
    const expression = compileExpression("steps.check.result.count >= run.iteration")

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
    expect(resultShapeFromJsonValue("text")).toEqual(StringShape)
    expect(resultShapeFromJsonValue(1)).toEqual(IntegerShape)
    expect(resultShapeFromJsonValue(1.5)).toEqual(NumberShape)
    expect(resultShapeFromJsonValue({ ok: true })).toEqual({
      fields: { ok: BooleanShape },
      kind: "object",
    })
    expect(resultShapeFromJsonValue([{ path: "a" }, { path: "b" }])).toEqual({
      items: {
        fields: { path: StringShape },
        kind: "object",
      },
      kind: "array",
    })
  })

  test("merges compatible and incompatible result shapes", () => {
    expect(mergeResultShapes(IntegerShape, NumberShape)).toEqual(NumberShape)
    expect(mergeResultShapes({ kind: "array", items: IntegerShape }, { kind: "array", items: NumberShape })).toEqual({
      kind: "array",
      items: NumberShape,
    })
    expect(
      mergeResultShapes(
        { kind: "object", fields: { count: IntegerShape } },
        { kind: "object", fields: { count: IntegerShape } },
      ),
    ).toEqual({ kind: "object", fields: { count: IntegerShape } })
    expect(
      mergeResultShapes(
        { kind: "object", fields: { count: IntegerShape } },
        { kind: "object", fields: { total: IntegerShape } },
      ),
    ).toEqual(AnyJsonShape)
  })
})
