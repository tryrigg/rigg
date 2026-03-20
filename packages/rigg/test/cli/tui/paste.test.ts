import { describe, expect, test } from "bun:test"

import {
  acquirePaste,
  createSegments,
  detectPaste,
  displayValue,
  expandedValue,
  normalizeChunk,
  reconcileSegments,
  reconcileState,
  releasePaste,
  resetTerminal,
} from "../../../src/cli/tui/paste"

describe("cli/tui/paste", () => {
  test("enables bracketed paste mode once and disables it after the last focused input releases it", () => {
    const writes: string[] = []
    resetTerminal()

    acquirePaste({ isTTY: true, write: (data) => writes.push(data) })
    acquirePaste({ isTTY: true, write: (data) => writes.push(data) })
    releasePaste({ isTTY: true, write: (data) => writes.push(data) })
    releasePaste({ isTTY: true, write: (data) => writes.push(data) })

    expect(writes).toEqual(["\u001b[?2004h", "\u001b[?2004l"])
  })

  test("does not toggle bracketed paste mode on non-tty stdout", () => {
    const writes: string[] = []
    resetTerminal()

    acquirePaste({ isTTY: false, write: (data) => writes.push(data) })
    releasePaste({ isTTY: false, write: (data) => writes.push(data) })

    expect(writes).toEqual([])
  })

  test("normalizes pasted multiline chunks to canonical newlines", () => {
    expect(normalizeChunk("a\rb")).toBe("a\nb")
    expect(normalizeChunk("a\r\nb")).toBe("a\nb")
    expect(normalizeChunk("a\nb")).toBe("a\nb")
  })

  test("strips raw bracketed paste sentinels during normalization", () => {
    expect(normalizeChunk("\u001b[200~a\r\nb\u001b[201~")).toBe("a\nb")
  })

  test("recognizes bracketed paste control markers", () => {
    expect(detectPaste("\u001b[200~")).toBe("start")
    expect(detectPaste("[200~")).toBe("start")
    expect(detectPaste("\u001b[201~")).toBe("end")
    expect(detectPaste("[201~")).toBe("end")
  })

  test("reconciles placeholders against the controlled value", () => {
    const segments = [
      { kind: "paste", pasteId: 1, text: "alpha\nbeta" } as const,
      { kind: "text", text: "\ngamma" } as const,
    ]

    expect(displayValue(segments)).toBe("[Pasted text #1 +1 lines]\ngamma")
    expect(expandedValue(segments)).toBe("alpha\nbeta\ngamma")

    const reconciled = reconcileSegments({
      segments,
      value: "rewritten",
    })
    expect(reconciled).toEqual(createSegments("rewritten"))

    expect(
      reconcileState({
        cursorOffset: 4,
        segments,
        value: "rewritten",
      }),
    ).toEqual({
      cursorOffset: "rewritten".length,
      segments: [{ kind: "text", text: "rewritten" }],
    })
  })
})
