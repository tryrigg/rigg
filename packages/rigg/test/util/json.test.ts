import { describe, expect, test } from "bun:test"

import { normalizeInputs } from "../../src/session/input"
import { safeParseJson } from "../../src/util/json"
import type { WorkflowDocument } from "../../src/workflow/schema"

describe("util/json", () => {
  test("safeParseJson returns parsed values for valid JSON", () => {
    expect(safeParseJson('{"ok":true}')).toEqual({
      kind: "ok",
      value: { ok: true },
    })
  })

  test("safeParseJson preserves explicit null values", () => {
    expect(safeParseJson("null")).toEqual({
      kind: "ok",
      value: null,
    })
  })

  test("safeParseJson reports invalid JSON without throwing", () => {
    expect(safeParseJson("{not json")).toEqual({ kind: "invalid" })
  })

  test("callers can fall back when parsed JSON would not satisfy their schema", () => {
    const workflow: WorkflowDocument = {
      id: "review",
      inputs: {
        note: { type: "string" },
      },
      steps: [{ type: "shell", with: { command: "echo hi" } }],
    }

    expect(normalizeInputs(workflow, { note: "null" })).toEqual({
      inputs: {
        note: "null",
      },
      kind: "valid",
    })
  })
})
