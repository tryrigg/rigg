import { describe, expect, test } from "bun:test"

import {
  acquirePromptTextInputBracketedPaste,
  createPromptTextInputSegments,
  detectPromptPasteControl,
  getPromptTextInputDisplayValue,
  getPromptTextInputExpandedValue,
  normalizePromptInputChunk,
  reconcilePromptTextInputControlledState,
  reconcilePromptTextInputSegments,
  releasePromptTextInputBracketedPaste,
  resetPromptTextInputTerminalState,
} from "../../../src/cli/tui/prompt-text-paste"

describe("cli/tui/prompt-text-paste", () => {
  test("enables bracketed paste mode once and disables it after the last focused input releases it", () => {
    const writes: string[] = []
    resetPromptTextInputTerminalState()

    acquirePromptTextInputBracketedPaste({ isTTY: true, write: (data) => writes.push(data) })
    acquirePromptTextInputBracketedPaste({ isTTY: true, write: (data) => writes.push(data) })
    releasePromptTextInputBracketedPaste({ isTTY: true, write: (data) => writes.push(data) })
    releasePromptTextInputBracketedPaste({ isTTY: true, write: (data) => writes.push(data) })

    expect(writes).toEqual(["\u001b[?2004h", "\u001b[?2004l"])
  })

  test("does not toggle bracketed paste mode on non-tty stdout", () => {
    const writes: string[] = []
    resetPromptTextInputTerminalState()

    acquirePromptTextInputBracketedPaste({ isTTY: false, write: (data) => writes.push(data) })
    releasePromptTextInputBracketedPaste({ isTTY: false, write: (data) => writes.push(data) })

    expect(writes).toEqual([])
  })

  test("normalizes pasted multiline chunks to canonical newlines", () => {
    expect(normalizePromptInputChunk("a\rb")).toBe("a\nb")
    expect(normalizePromptInputChunk("a\r\nb")).toBe("a\nb")
    expect(normalizePromptInputChunk("a\nb")).toBe("a\nb")
  })

  test("strips raw bracketed paste sentinels during normalization", () => {
    expect(normalizePromptInputChunk("\u001b[200~a\r\nb\u001b[201~")).toBe("a\nb")
  })

  test("recognizes bracketed paste control markers", () => {
    expect(detectPromptPasteControl("\u001b[200~")).toBe("start")
    expect(detectPromptPasteControl("[200~")).toBe("start")
    expect(detectPromptPasteControl("\u001b[201~")).toBe("end")
    expect(detectPromptPasteControl("[201~")).toBe("end")
  })

  test("reconciles placeholders against the controlled value", () => {
    const segments = [
      { kind: "paste", pasteId: 1, text: "alpha\nbeta" } as const,
      { kind: "text", text: "\ngamma" } as const,
    ]

    expect(getPromptTextInputDisplayValue(segments)).toBe("[Pasted text #1 +1 lines]\ngamma")
    expect(getPromptTextInputExpandedValue(segments)).toBe("alpha\nbeta\ngamma")

    const reconciled = reconcilePromptTextInputSegments({
      segments,
      value: "rewritten",
    })
    expect(reconciled).toEqual(createPromptTextInputSegments("rewritten"))

    expect(
      reconcilePromptTextInputControlledState({
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
