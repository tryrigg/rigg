import { describe, expect, test } from "bun:test"
import { renderToString } from "ink"

import {
  acquirePromptTextInputBracketedPaste,
  applyPromptTextInputKey,
  applyPromptTextInputSegmentsKey,
  createPromptTextInputSegments,
  detectPromptPasteControl,
  getPromptTextInputDisplayValue,
  getPromptTextInputExpandedValue,
  normalizePromptInputChunk,
  PromptTextInput,
  reconcilePromptTextInputControlledState,
  reconcilePromptTextInputSegments,
  releasePromptTextInputBracketedPaste,
  resetPromptTextInputTerminalState,
  type PromptTextInputKey,
} from "../../../src/cli/tui/prompt-text-input"

function createKey(overrides: Partial<PromptTextInputKey> = {}): PromptTextInputKey {
  return {
    backspace: false,
    ctrl: false,
    delete: false,
    downArrow: false,
    end: false,
    eventType: "press",
    home: false,
    leftArrow: false,
    meta: false,
    return: false,
    rightArrow: false,
    shift: false,
    tab: false,
    upArrow: false,
    ...overrides,
  }
}

describe("prompt-text-input", () => {
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

  test("submits on plain return", () => {
    expect(
      applyPromptTextInputKey({
        cursorOffset: 5,
        input: "\r",
        key: createKey({ return: true }),
        value: "hello",
      }),
    ).toEqual({ kind: "submit" })
  })

  test("inserts a newline on shift+return", () => {
    expect(
      applyPromptTextInputKey({
        cursorOffset: 5,
        input: "\r",
        key: createKey({ return: true, shift: true }),
        value: "hello",
      }),
    ).toEqual({
      cursorOffset: 6,
      kind: "update",
      preferredColumn: null,
      value: "hello\n",
    })
  })

  test("normalizes multiline paste before inserting it", () => {
    expect(
      applyPromptTextInputKey({
        cursorOffset: 1,
        input: "a\r\nb\rc",
        key: createKey(),
        value: "[]",
      }),
    ).toEqual({
      cursorOffset: 6,
      kind: "update",
      preferredColumn: null,
      value: "[a\nb\nc]",
    })
  })

  test("collapses multiline paste into a numbered placeholder while keeping expanded text", () => {
    const action = applyPromptTextInputSegmentsKey({
      cursorOffset: 0,
      input: "alpha\r\nbeta",
      key: createKey(),
      nextPasteId: 1,
      segments: [],
      treatAsPaste: true,
    })

    expect(action.kind).toBe("update")
    if (action.kind !== "update") {
      return
    }

    expect(getPromptTextInputDisplayValue(action.segments)).toBe("[Pasted text #1 +1 lines]")
    expect(getPromptTextInputExpandedValue(action.segments)).toBe("alpha\nbeta")
    expect(action.cursorOffset).toBe("[Pasted text #1 +1 lines]".length)
    expect(action.nextPasteId).toBe(2)
  })

  test("keeps consecutive multiline paste placeholders adjacent and increments numbering", () => {
    const first = applyPromptTextInputSegmentsKey({
      cursorOffset: 0,
      input: "alpha\nbeta",
      key: createKey(),
      nextPasteId: 1,
      segments: [],
      treatAsPaste: true,
    })

    expect(first.kind).toBe("update")
    if (first.kind !== "update") {
      return
    }

    const second = applyPromptTextInputSegmentsKey({
      cursorOffset: first.cursorOffset,
      input: "gamma\r\ndelta\r\nepsilon",
      key: createKey(),
      nextPasteId: first.nextPasteId,
      segments: first.segments,
      treatAsPaste: true,
    })

    expect(second.kind).toBe("update")
    if (second.kind !== "update") {
      return
    }

    expect(getPromptTextInputDisplayValue(second.segments)).toBe("[Pasted text #1 +1 lines][Pasted text #2 +2 lines]")
    expect(getPromptTextInputExpandedValue(second.segments)).toBe("alpha\nbetagamma\ndelta\nepsilon")
    expect(second.nextPasteId).toBe(3)
  })

  test("single-line paste stays literal while shift+return inserts a literal newline", () => {
    const singleLine = applyPromptTextInputSegmentsKey({
      cursorOffset: 0,
      input: "alpha beta",
      key: createKey(),
      nextPasteId: 1,
      segments: [],
    })

    expect(singleLine.kind).toBe("update")
    if (singleLine.kind !== "update") {
      return
    }

    expect(getPromptTextInputDisplayValue(singleLine.segments)).toBe("alpha beta")
    expect(getPromptTextInputExpandedValue(singleLine.segments)).toBe("alpha beta")
    expect(singleLine.nextPasteId).toBe(1)

    const newline = applyPromptTextInputSegmentsKey({
      cursorOffset: singleLine.cursorOffset,
      input: "\r",
      key: createKey({ return: true, shift: true }),
      nextPasteId: singleLine.nextPasteId,
      segments: singleLine.segments,
    })

    expect(newline.kind).toBe("update")
    if (newline.kind !== "update") {
      return
    }

    expect(getPromptTextInputDisplayValue(newline.segments)).toBe("alpha beta\n")
    expect(getPromptTextInputExpandedValue(newline.segments)).toBe("alpha beta\n")
    expect(newline.nextPasteId).toBe(1)
  })

  test("backspace removes an entire paste placeholder atomically", () => {
    const pasted = applyPromptTextInputSegmentsKey({
      cursorOffset: 0,
      input: "alpha\nbeta",
      key: createKey(),
      nextPasteId: 1,
      segments: [],
      treatAsPaste: true,
    })

    expect(pasted.kind).toBe("update")
    if (pasted.kind !== "update") {
      return
    }

    const deleted = applyPromptTextInputSegmentsKey({
      cursorOffset: pasted.cursorOffset,
      input: "",
      key: createKey({ backspace: true }),
      nextPasteId: pasted.nextPasteId,
      segments: pasted.segments,
    })

    expect(deleted).toEqual({
      cursorOffset: 0,
      kind: "update",
      nextPasteId: 2,
      preferredColumn: null,
      segments: [],
    })
  })

  test("delete matches backspace semantics and removes the previous grapheme", () => {
    expect(
      applyPromptTextInputKey({
        cursorOffset: 2,
        input: "",
        key: createKey({ delete: true }),
        value: "abcd",
      }),
    ).toEqual({
      cursorOffset: 1,
      kind: "update",
      preferredColumn: null,
      value: "acd",
    })

    expect(
      applyPromptTextInputKey({
        cursorOffset: 4,
        input: "",
        key: createKey({ delete: true }),
        value: "abcd",
      }),
    ).toEqual({
      cursorOffset: 3,
      kind: "update",
      preferredColumn: null,
      value: "abc",
    })

    expect(
      applyPromptTextInputKey({
        cursorOffset: 0,
        input: "",
        key: createKey({ delete: true }),
        value: "",
      }),
    ).toEqual({ kind: "noop" })
  })

  test("moves and deletes whole graphemes in plain text", () => {
    expect(
      applyPromptTextInputKey({
        cursorOffset: "🙂".length,
        input: "",
        key: createKey({ leftArrow: true }),
        value: "🙂",
      }),
    ).toEqual({
      cursorOffset: 0,
      kind: "update",
      preferredColumn: null,
      value: "🙂",
    })

    expect(
      applyPromptTextInputKey({
        cursorOffset: "🙂".length,
        input: "",
        key: createKey({ backspace: true }),
        value: "🙂",
      }),
    ).toEqual({
      cursorOffset: 0,
      kind: "update",
      preferredColumn: null,
      value: "",
    })

    expect(
      applyPromptTextInputKey({
        cursorOffset: "🙂".length,
        input: "",
        key: createKey({ delete: true }),
        value: "🙂a",
      }),
    ).toEqual({
      cursorOffset: 0,
      kind: "update",
      preferredColumn: null,
      value: "a",
    })
  })

  test("delete removes a paste placeholder atomically from its trailing edge", () => {
    const pasted = applyPromptTextInputSegmentsKey({
      cursorOffset: 0,
      input: "alpha\nbeta",
      key: createKey(),
      nextPasteId: 1,
      segments: [],
      treatAsPaste: true,
    })

    expect(pasted.kind).toBe("update")
    if (pasted.kind !== "update") {
      return
    }

    const deleted = applyPromptTextInputSegmentsKey({
      cursorOffset: pasted.cursorOffset,
      input: "",
      key: createKey({ delete: true }),
      nextPasteId: pasted.nextPasteId,
      segments: pasted.segments,
    })

    expect(deleted).toEqual({
      cursorOffset: 0,
      kind: "update",
      nextPasteId: 2,
      preferredColumn: null,
      segments: [],
    })
  })

  test("left and right arrows skip across a paste placeholder atomically", () => {
    const pasted = applyPromptTextInputSegmentsKey({
      cursorOffset: 0,
      input: "alpha\nbeta",
      key: createKey(),
      nextPasteId: 1,
      segments: [],
      treatAsPaste: true,
    })

    expect(pasted.kind).toBe("update")
    if (pasted.kind !== "update") {
      return
    }

    const movedLeft = applyPromptTextInputSegmentsKey({
      cursorOffset: pasted.cursorOffset,
      input: "",
      key: createKey({ leftArrow: true }),
      nextPasteId: pasted.nextPasteId,
      segments: pasted.segments,
    })

    expect(movedLeft).toEqual({
      cursorOffset: 0,
      kind: "update",
      nextPasteId: 2,
      preferredColumn: null,
      segments: pasted.segments,
    })

    const movedRight = applyPromptTextInputSegmentsKey({
      cursorOffset: 0,
      input: "",
      key: createKey({ rightArrow: true }),
      nextPasteId: pasted.nextPasteId,
      segments: pasted.segments,
    })

    expect(movedRight).toEqual({
      cursorOffset: "[Pasted text #1 +1 lines]".length,
      kind: "update",
      nextPasteId: 2,
      preferredColumn: null,
      segments: pasted.segments,
    })
  })

  test("moves and deletes whole graphemes in segmented literal text", () => {
    const segments = createPromptTextInputSegments("🙂a")

    expect(
      applyPromptTextInputSegmentsKey({
        cursorOffset: "🙂".length,
        input: "",
        key: createKey({ leftArrow: true }),
        nextPasteId: 1,
        segments,
      }),
    ).toEqual({
      cursorOffset: 0,
      kind: "update",
      nextPasteId: 1,
      preferredColumn: null,
      segments,
    })

    expect(
      applyPromptTextInputSegmentsKey({
        cursorOffset: "🙂".length,
        input: "",
        key: createKey({ delete: true }),
        nextPasteId: 1,
        segments,
      }),
    ).toEqual({
      cursorOffset: 0,
      kind: "update",
      nextPasteId: 1,
      preferredColumn: null,
      segments: createPromptTextInputSegments("a"),
    })
  })

  test("submit keeps the expanded multiline payload instead of placeholder text", () => {
    const pasted = applyPromptTextInputSegmentsKey({
      cursorOffset: 0,
      input: "alpha\nbeta",
      key: createKey(),
      nextPasteId: 1,
      segments: [],
      treatAsPaste: true,
    })

    expect(pasted.kind).toBe("update")
    if (pasted.kind !== "update") {
      return
    }

    expect(
      applyPromptTextInputSegmentsKey({
        cursorOffset: pasted.cursorOffset,
        input: "\r",
        key: createKey({ return: true }),
        nextPasteId: pasted.nextPasteId,
        segments: pasted.segments,
      }),
    ).toEqual({ kind: "submit" })
    expect(getPromptTextInputExpandedValue(pasted.segments)).toBe("alpha\nbeta")
  })

  test("reconciliation clears placeholder metadata when external value changes", () => {
    const pasted = applyPromptTextInputSegmentsKey({
      cursorOffset: 0,
      input: "alpha\nbeta",
      key: createKey(),
      nextPasteId: 1,
      segments: [],
      treatAsPaste: true,
    })

    expect(pasted.kind).toBe("update")
    if (pasted.kind !== "update") {
      return
    }

    const reconciled = reconcilePromptTextInputSegments({
      segments: pasted.segments,
      value: "reset\nvalue",
    })

    expect(reconciled).toEqual(createPromptTextInputSegments("reset\nvalue"))
    expect(getPromptTextInputDisplayValue(reconciled)).toBe("reset\nvalue")
    expect(getPromptTextInputExpandedValue(reconciled)).toBe("reset\nvalue")
  })

  test("controlled value replacement resets the cursor to the end of the new text", () => {
    expect(
      reconcilePromptTextInputControlledState({
        cursorOffset: 2,
        segments: createPromptTextInputSegments("old"),
        value: "plan.md",
      }),
    ).toEqual({
      cursorOffset: "plan.md".length,
      segments: createPromptTextInputSegments("plan.md"),
    })

    const unchangedSegments = createPromptTextInputSegments("plan.md")
    expect(
      reconcilePromptTextInputControlledState({
        cursorOffset: 2,
        segments: unchangedSegments,
        value: "plan.md",
      }),
    ).toEqual({
      cursorOffset: 2,
      segments: unchangedSegments,
    })
  })

  test("multiline input without paste context stays literal text", () => {
    const action = applyPromptTextInputSegmentsKey({
      cursorOffset: 0,
      input: "alpha\nbeta",
      key: createKey(),
      nextPasteId: 1,
      segments: [],
      treatAsPaste: false,
    })

    expect(action.kind).toBe("update")
    if (action.kind !== "update") {
      return
    }

    expect(getPromptTextInputDisplayValue(action.segments)).toBe("alpha\nbeta")
    expect(getPromptTextInputExpandedValue(action.segments)).toBe("alpha\nbeta")
    expect(action.nextPasteId).toBe(1)
  })

  test("moves vertically while preserving the preferred column", () => {
    expect(
      applyPromptTextInputKey({
        cursorOffset: 8,
        input: "",
        key: createKey({ upArrow: true }),
        value: "12345\n12\n123456",
      }),
    ).toEqual({
      cursorOffset: 2,
      kind: "update",
      preferredColumn: 2,
      value: "12345\n12\n123456",
    })

    expect(
      applyPromptTextInputKey({
        cursorOffset: 2,
        input: "",
        key: createKey({ downArrow: true }),
        preferredColumn: 2,
        value: "12345\n12\n123456",
      }),
    ).toEqual({
      cursorOffset: 8,
      kind: "update",
      preferredColumn: 2,
      value: "12345\n12\n123456",
    })
  })

  test("uses meta+left and meta+right for word jumps", () => {
    expect(
      applyPromptTextInputKey({
        cursorOffset: "result: jsonl".length,
        input: "",
        key: createKey({ leftArrow: true, meta: true }),
        value: "result: jsonl",
      }),
    ).toEqual({
      cursorOffset: 8,
      kind: "update",
      preferredColumn: null,
      value: "result: jsonl",
    })

    expect(
      applyPromptTextInputKey({
        cursorOffset: 0,
        input: "",
        key: createKey({ rightArrow: true, meta: true }),
        value: "result: jsonl",
      }),
    ).toEqual({
      cursorOffset: 6,
      kind: "update",
      preferredColumn: null,
      value: "result: jsonl",
    })
  })

  test("treats meta+b and meta+f as word jumps for terminals that send esc+b/esc+f", () => {
    expect(
      applyPromptTextInputKey({
        cursorOffset: "result: jsonl".length,
        input: "b",
        key: createKey({ meta: true }),
        value: "result: jsonl",
      }),
    ).toEqual({
      cursorOffset: 8,
      kind: "update",
      preferredColumn: null,
      value: "result: jsonl",
    })

    expect(
      applyPromptTextInputKey({
        cursorOffset: 0,
        input: "f",
        key: createKey({ meta: true }),
        value: "result: jsonl",
      }),
    ).toEqual({
      cursorOffset: 6,
      kind: "update",
      preferredColumn: null,
      value: "result: jsonl",
    })
  })

  test("moves to line start and end with home/end and ctrl+a/e", () => {
    expect(
      applyPromptTextInputKey({
        cursorOffset: 10,
        input: "",
        key: createKey({ home: true }),
        value: "hello\nworld here",
      }),
    ).toEqual({
      cursorOffset: 6,
      kind: "update",
      preferredColumn: null,
      value: "hello\nworld here",
    })

    expect(
      applyPromptTextInputKey({
        cursorOffset: 7,
        input: "",
        key: createKey({ end: true }),
        value: "hello\nworld here",
      }),
    ).toEqual({
      cursorOffset: 16,
      kind: "update",
      preferredColumn: null,
      value: "hello\nworld here",
    })

    expect(
      applyPromptTextInputKey({
        cursorOffset: 10,
        input: "a",
        key: createKey({ ctrl: true }),
        value: "hello\nworld here",
      }),
    ).toEqual({
      cursorOffset: 6,
      kind: "update",
      preferredColumn: null,
      value: "hello\nworld here",
    })

    expect(
      applyPromptTextInputKey({
        cursorOffset: 7,
        input: "e",
        key: createKey({ ctrl: true }),
        value: "hello\nworld here",
      }),
    ).toEqual({
      cursorOffset: 16,
      kind: "update",
      preferredColumn: null,
      value: "hello\nworld here",
    })
  })

  test("deletes the previous word with meta+backspace and ctrl+w", () => {
    expect(
      applyPromptTextInputKey({
        cursorOffset: "result: jsonl".length,
        input: "",
        key: createKey({ backspace: true, meta: true }),
        value: "result: jsonl",
      }),
    ).toEqual({
      cursorOffset: 8,
      kind: "update",
      preferredColumn: null,
      value: "result: ",
    })

    expect(
      applyPromptTextInputKey({
        cursorOffset: "result: jsonl".length,
        input: "w",
        key: createKey({ ctrl: true }),
        value: "result: jsonl",
      }),
    ).toEqual({
      cursorOffset: 8,
      kind: "update",
      preferredColumn: null,
      value: "result: ",
    })
  })

  test("deletes the previous word in segmented inputs with meta+backspace and ctrl+w", () => {
    const pasted = applyPromptTextInputSegmentsKey({
      cursorOffset: 0,
      input: "alpha\r\nbeta",
      key: createKey(),
      nextPasteId: 1,
      segments: [],
      treatAsPaste: true,
    })

    expect(pasted.kind).toBe("update")
    if (pasted.kind !== "update") {
      return
    }

    expect(
      applyPromptTextInputSegmentsKey({
        cursorOffset: "result: jsonl".length,
        input: "",
        key: createKey({ backspace: true, meta: true }),
        nextPasteId: pasted.nextPasteId,
        segments: createPromptTextInputSegments("result: jsonl"),
      }),
    ).toEqual({
      cursorOffset: 8,
      kind: "update",
      nextPasteId: pasted.nextPasteId,
      preferredColumn: null,
      segments: createPromptTextInputSegments("result: "),
    })

    expect(
      applyPromptTextInputSegmentsKey({
        cursorOffset: "result: jsonl".length,
        input: "w",
        key: createKey({ ctrl: true }),
        nextPasteId: pasted.nextPasteId,
        segments: createPromptTextInputSegments("result: jsonl"),
      }),
    ).toEqual({
      cursorOffset: 8,
      kind: "update",
      nextPasteId: pasted.nextPasteId,
      preferredColumn: null,
      segments: createPromptTextInputSegments("result: "),
    })
  })

  test("ignores kitty release events", () => {
    expect(
      applyPromptTextInputKey({
        cursorOffset: 0,
        input: "a",
        key: createKey({ eventType: "release" }),
        value: "",
      }),
    ).toEqual({ kind: "noop" })
  })

  test("renders multiline input without raw carriage returns", () => {
    const frame = renderToString(<PromptTextInput value={"hello\r\nworld"} onChange={() => {}} onSubmit={() => {}} />, {
      columns: 20,
    })

    expect(frame).toContain("hello\nworld")
    expect(frame).not.toContain("\r")
  })
})
