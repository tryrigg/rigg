import { describe, expect, test } from "bun:test"

import {
  applyPromptTextInputKey,
  applyPromptTextInputSegmentsKey,
  type PromptTextInputKey,
} from "../../../src/cli/tui/prompt-text-edit"
import { getPromptTextInputDisplayValue, getPromptTextInputExpandedValue } from "../../../src/cli/tui/prompt-text-paste"

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

describe("cli/tui/prompt-text-edit", () => {
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
  })

  test("deletes a placeholder atomically from either edge", () => {
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

    const backspace = applyPromptTextInputSegmentsKey({
      cursorOffset: pasted.cursorOffset,
      input: "\u007f",
      key: createKey({ backspace: true }),
      nextPasteId: pasted.nextPasteId,
      segments: pasted.segments,
    })
    expect(backspace.kind).toBe("update")
    if (backspace.kind !== "update") {
      return
    }
    expect(backspace.segments).toEqual([])

    const pastedAgain = applyPromptTextInputSegmentsKey({
      cursorOffset: 0,
      input: "alpha\nbeta",
      key: createKey(),
      nextPasteId: 1,
      segments: [],
      treatAsPaste: true,
    })
    expect(pastedAgain.kind).toBe("update")
    if (pastedAgain.kind !== "update") {
      return
    }

    const deleteFromTrail = applyPromptTextInputSegmentsKey({
      cursorOffset: pastedAgain.cursorOffset,
      input: "\u007f",
      key: createKey({ delete: true }),
      nextPasteId: pastedAgain.nextPasteId,
      segments: pastedAgain.segments,
    })
    expect(deleteFromTrail.kind).toBe("update")
    if (deleteFromTrail.kind !== "update") {
      return
    }
    expect(deleteFromTrail.segments).toEqual([])
  })

  test("moves vertically while preserving the preferred column", () => {
    const down = applyPromptTextInputKey({
      cursorOffset: 2,
      input: "",
      key: createKey({ downArrow: true }),
      value: "abc\nde\nfghi",
    })
    expect(down).toEqual({
      cursorOffset: 6,
      kind: "update",
      preferredColumn: 2,
      value: "abc\nde\nfghi",
    })
  })

  test("uses meta+left and meta+right for word jumps", () => {
    expect(
      applyPromptTextInputKey({
        cursorOffset: 11,
        input: "",
        key: createKey({ leftArrow: true, meta: true }),
        value: "hello brave new",
      }),
    ).toEqual({
      cursorOffset: 6,
      kind: "update",
      preferredColumn: null,
      value: "hello brave new",
    })

    expect(
      applyPromptTextInputKey({
        cursorOffset: 6,
        input: "",
        key: createKey({ meta: true, rightArrow: true }),
        value: "hello brave new",
      }),
    ).toEqual({
      cursorOffset: 11,
      kind: "update",
      preferredColumn: null,
      value: "hello brave new",
    })
  })

  test("moves to line start and end with home/end and ctrl+a/e", () => {
    expect(
      applyPromptTextInputKey({
        cursorOffset: 7,
        input: "",
        key: createKey({ home: true }),
        value: "abc\ndef",
      }),
    ).toEqual({
      cursorOffset: 4,
      kind: "update",
      preferredColumn: null,
      value: "abc\ndef",
    })

    expect(
      applyPromptTextInputKey({
        cursorOffset: 5,
        input: "e",
        key: createKey({ ctrl: true }),
        value: "abc\ndef",
      }),
    ).toEqual({
      cursorOffset: 7,
      kind: "update",
      preferredColumn: null,
      value: "abc\ndef",
    })
  })

  test("deletes the previous word with meta+backspace and ctrl+w", () => {
    expect(
      applyPromptTextInputKey({
        cursorOffset: 11,
        input: "\u007f",
        key: createKey({ backspace: true, meta: true }),
        value: "hello brave new",
      }),
    ).toEqual({
      cursorOffset: 6,
      kind: "update",
      preferredColumn: null,
      value: "hello  new",
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
})
