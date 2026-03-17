import { describe, expect, test } from "bun:test"

import {
  coerceInvocationInputValue,
  findOmittedInvocationInputs,
  mergePromptedInvocationInputs,
  normalizeInvocationInputs,
  parseInvocationInputEntries,
} from "../../src/run/invocation"
import type { WorkflowDocument } from "../../src/compile/schema"

describe("run/invocation", () => {
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

  test("finds omitted declared inputs, including ones with defaults", () => {
    const workflow: WorkflowDocument = {
      id: "review",
      inputs: {
        count: { type: "integer" },
        name: { type: "string" },
        output_path: { default: "plan.md", type: "string" },
      },
      steps: [{ type: "shell", with: { command: "echo hi" } }],
    }

    expect(findOmittedInvocationInputs(workflow, { name: "Rigg" })).toEqual([
      {
        key: "count",
        schema: { type: "integer" },
      },
      {
        key: "output_path",
        schema: { default: "plan.md", type: "string" },
      },
    ])
  })

  test("parses invocation inputs as raw strings before schema-aware normalization", () => {
    expect(parseInvocationInputEntries(["enabled=true", 'labels=["a"]', "name=Rigg"])).toEqual({
      inputs: {
        enabled: "true",
        labels: '["a"]',
        name: "Rigg",
      },
      kind: "valid",
    })
  })

  test("coerces raw string invocation inputs according to schema", () => {
    expect(coerceInvocationInputValue({ type: "string" }, "true")).toBe("true")
    expect(coerceInvocationInputValue({ type: "integer" }, "42")).toBe(42)
    expect(coerceInvocationInputValue({ type: "boolean" }, "true")).toBe(true)
    expect(coerceInvocationInputValue({ type: "object" }, '{"enabled":true}')).toEqual({ enabled: true })
    expect(coerceInvocationInputValue({ type: "array", items: { type: "string" } }, '["a"]')).toEqual(["a"])
    expect(coerceInvocationInputValue({ type: "integer" }, "null")).toBe("null")
    expect(coerceInvocationInputValue({ type: "integer" }, "{oops")).toBe("{oops")
  })

  test("merges prompted answers without coercing string values up front", () => {
    expect(
      mergePromptedInvocationInputs(
        { name: "Rigg" },
        {
          count: "42",
          flags: '["a","b"]',
          raw: "{not json",
        },
      ),
    ).toEqual({
      count: "42",
      flags: '["a","b"]',
      name: "Rigg",
      raw: "{not json",
    })
  })

  test("normalizes raw string invocation inputs through schema validation", () => {
    const workflow: WorkflowDocument = {
      id: "review",
      inputs: {
        count: { type: "integer" },
        enabled: { type: "boolean" },
        note: { type: "string" },
      },
      steps: [{ type: "shell", with: { command: "echo hi" } }],
    }

    const merged = mergePromptedInvocationInputs({}, { count: "42", enabled: "true", note: "true" })
    expect(normalizeInvocationInputs(workflow, merged)).toEqual({
      inputs: {
        count: 42,
        enabled: true,
        note: "true",
      },
      kind: "valid",
    })
  })

  test("preserves empty and whitespace-only strings through normalization", () => {
    const workflow: WorkflowDocument = {
      id: "review",
      inputs: {
        empty: { type: "string" },
        spaced: { type: "string" },
      },
      steps: [{ type: "shell", with: { command: "echo hi" } }],
    }

    expect(normalizeInvocationInputs(workflow, { empty: "", spaced: "  hello  " })).toEqual({
      inputs: {
        empty: "",
        spaced: "  hello  ",
      },
      kind: "valid",
    })
  })

  test("invalid raw strings still surface through schema validation", () => {
    const workflow: WorkflowDocument = {
      id: "review",
      inputs: {
        count: { type: "integer" },
      },
      steps: [{ type: "shell", with: { command: "echo hi" } }],
    }

    const merged = mergePromptedInvocationInputs({}, { count: "abc" })
    expect(normalizeInvocationInputs(workflow, merged)).toEqual({
      errors: ["inputs.count must be an integer"],
      kind: "invalid",
    })
  })
})
