import { describe, expect, test } from "bun:test"

import { parseCollaborationModeListResponse, parseReviewText } from "../../src/codex/protocol"

describe("codex/protocol", () => {
  test("parses collaboration mode presets from the app-server", () => {
    expect(
      parseCollaborationModeListResponse({
        data: [
          { name: "Plan", mode: "plan", model: "gpt-5.4", reasoning_effort: "medium" },
          { name: "Default", mode: "default", model: "gpt-5.4", reasoning_effort: null },
        ],
      }),
    ).toEqual([
      { name: "Plan", mode: "plan", model: "gpt-5.4", reasoning_effort: "medium" },
      { name: "Default", mode: "default", model: "gpt-5.4", reasoning_effort: null },
    ])
  })

  test("parses a canonical review finding", () => {
    const result = parseReviewText(
      [
        "Looks solid overall with minor polish suggested.",
        "",
        "Review comment:",
        "",
        "- Prefer Stylize helpers — /tmp/file.rs:10-20",
        "  Use .dim()/.bold() chaining instead of manual Style.",
      ].join("\n"),
    )

    expect(result).toEqual({
      findings: [
        {
          body: "Use .dim()/.bold() chaining instead of manual Style.",
          code_location: {
            absolute_file_path: "/tmp/file.rs",
            line_range: {
              end: 20,
              start: 10,
            },
          },
          confidence_score: 0,
          priority: null,
          title: "Prefer Stylize helpers",
        },
      ],
      overall_confidence_score: 0,
      overall_correctness: "unknown",
      overall_explanation: "Looks solid overall with minor polish suggested.",
    })
  })

  test("parses a single-line location", () => {
    const result = parseReviewText(
      ["Review comment:", "- [x] Keep the handler pure — /tmp/file.ts:10", "  Avoid mutating shared state here."].join(
        "\n",
      ),
    )

    expect(result.findings).toEqual([
      {
        body: "Avoid mutating shared state here.",
        code_location: {
          absolute_file_path: "/tmp/file.ts",
          line_range: {
            end: 10,
            start: 10,
          },
        },
        confidence_score: 0,
        priority: null,
        title: "Keep the handler pure",
      },
    ])
  })

  test("parses a column-qualified location into a line range", () => {
    const result = parseReviewText(
      ["Review comment:", "- Narrow the span — /tmp/file.ts:10:2-12:8", "  Point the fix at the exact block."].join(
        "\n",
      ),
    )

    expect(result.findings).toEqual([
      {
        body: "Point the fix at the exact block.",
        code_location: {
          absolute_file_path: "/tmp/file.ts",
          line_range: {
            end: 12,
            start: 10,
          },
        },
        confidence_score: 0,
        priority: null,
        title: "Narrow the span",
      },
    ])
  })

  test("keeps multiline bodies without requiring indentation", () => {
    const result = parseReviewText(
      [
        "Full review comments:",
        "",
        "- Expand the validation — /tmp/file.ts:10-20",
        "First line.",
        "",
        "Second paragraph.",
      ].join("\n"),
    )

    expect(result.findings).toEqual([
      {
        body: ["First line.", "", "Second paragraph."].join("\n"),
        code_location: {
          absolute_file_path: "/tmp/file.ts",
          line_range: {
            end: 20,
            start: 10,
          },
        },
        confidence_score: 0,
        priority: null,
        title: "Expand the validation",
      },
    ])
  })

  test("fails fast on unsupported review bullet locations", () => {
    expect(() =>
      parseReviewText(
        [
          "Review comment:",
          "- Unsupported location — /tmp/file.ts:line-ten",
          "  This should not become a clean review.",
        ].join("\n"),
      ),
    ).toThrow("unsupported code location")
  })
})
