import { describe, expect, test } from "bun:test"

import { applyKey, applySegmentsKey, type InputKey } from "../../../src/cli/tui/edit"
import { displayValue, expandedValue } from "../../../src/cli/tui/paste"

function createKey(overrides: Partial<InputKey> = {}): InputKey {
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

describe("cli/tui/edit", () => {
  test("submits on plain return", () => {
    expect(
      applyKey({
        cursorOffset: 5,
        input: "\r",
        key: createKey({ return: true }),
        value: "hello",
      }),
    ).toEqual({ kind: "submit" })
  })

  test("inserts a newline on shift+return", () => {
    expect(
      applyKey({
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
    const action = applySegmentsKey({
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

    expect(displayValue(action.segments)).toBe("[Pasted text #1 +1 lines]")
    expect(expandedValue(action.segments)).toBe("alpha\nbeta")
    expect(action.cursorOffset).toBe("[Pasted text #1 +1 lines]".length)
    expect(action.nextPasteId).toBe(2)
  })

  test("keeps consecutive multiline paste placeholders adjacent and increments numbering", () => {
    const first = applySegmentsKey({
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

    const second = applySegmentsKey({
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

    expect(displayValue(second.segments)).toBe("[Pasted text #1 +1 lines][Pasted text #2 +2 lines]")
    expect(expandedValue(second.segments)).toBe("alpha\nbetagamma\ndelta\nepsilon")
    expect(second.nextPasteId).toBe(3)
  })

  test("single-line paste stays literal while shift+return inserts a literal newline", () => {
    const singleLine = applySegmentsKey({
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

    expect(displayValue(singleLine.segments)).toBe("alpha beta")
    expect(expandedValue(singleLine.segments)).toBe("alpha beta")

    const newline = applySegmentsKey({
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

    expect(displayValue(newline.segments)).toBe("alpha beta\n")
  })

  test("deletes a placeholder atomically from either edge", () => {
    const pasted = applySegmentsKey({
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

    const backspace = applySegmentsKey({
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

    const pastedAgain = applySegmentsKey({
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

    const deleteFromTrail = applySegmentsKey({
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
    const down = applyKey({
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
      applyKey({
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
      applyKey({
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
      applyKey({
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
      applyKey({
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
      applyKey({
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
      applyKey({
        cursorOffset: 0,
        input: "a",
        key: createKey({ eventType: "release" }),
        value: "",
      }),
    ).toEqual({ kind: "noop" })
  })
})
