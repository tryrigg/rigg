import { describe, expect, test } from "bun:test"
import { snapSegments, snapString, wordLeft, wordRight } from "../../../src/cli/tui/cursor"

describe("cli/tui/cursor", () => {
  test("snaps to grapheme boundaries in plain strings", () => {
    expect(snapString("a😀b", 2, "left")).toBe(1)
    expect(snapString("a😀b", 2, "right")).toBe(3)
  })

  test("treats paste placeholders as atomic cursor targets", () => {
    const segments = [
      { kind: "text", text: "a" } as const,
      { kind: "paste", pasteId: 1, text: "alpha\nbeta" } as const,
      { kind: "text", text: "z" } as const,
    ]

    expect(snapSegments(segments, 5, "left")).toBe(1)
    expect(snapSegments(segments, 5, "right")).toBe("[Pasted text #1 +1 lines]".length + 1)
  })

  test("finds word boundaries", () => {
    expect(wordLeft("hello brave new", 11)).toBe(6)
    expect(wordRight("hello brave new", 6)).toBe(11)
  })

  test("snaps across newlines without introducing carriage returns", () => {
    expect(snapString("hello\nworld", 5, "nearest")).toBe(5)
    expect(snapString("hello\nworld", 6, "nearest")).toBe(6)
  })
})
