import { describe, expect, test } from "bun:test"
import {
  findWordBoundaryLeft,
  findWordBoundaryRight,
  snapPromptTextInputCursorOffset,
  snapPromptTextInputStringCursorOffset,
} from "../../../src/cli/tui/prompt-text-cursor"

describe("cli/tui/prompt-text-cursor", () => {
  test("snaps to grapheme boundaries in plain strings", () => {
    expect(snapPromptTextInputStringCursorOffset("a😀b", 2, "left")).toBe(1)
    expect(snapPromptTextInputStringCursorOffset("a😀b", 2, "right")).toBe(3)
  })

  test("treats paste placeholders as atomic cursor targets", () => {
    const segments = [
      { kind: "text", text: "a" } as const,
      { kind: "paste", pasteId: 1, text: "alpha\nbeta" } as const,
      { kind: "text", text: "z" } as const,
    ]

    expect(snapPromptTextInputCursorOffset(segments, 5, "left")).toBe(1)
    expect(snapPromptTextInputCursorOffset(segments, 5, "right")).toBe("[Pasted text #1 +1 lines]".length + 1)
  })

  test("finds word boundaries", () => {
    expect(findWordBoundaryLeft("hello brave new", 11)).toBe(6)
    expect(findWordBoundaryRight("hello brave new", 6)).toBe(11)
  })

  test("snaps across newlines without introducing carriage returns", () => {
    expect(snapPromptTextInputStringCursorOffset("hello\nworld", 5, "nearest")).toBe(5)
    expect(snapPromptTextInputStringCursorOffset("hello\nworld", 6, "nearest")).toBe(6)
  })
})
