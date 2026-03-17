import { describe, expect, test } from "bun:test"

import { allowsShortcut, matchesShortcut } from "../../../src/cli/tui/input"

const plainKey = {
  ctrl: false,
  hyper: false,
  meta: false,
  super: false,
} as const

describe("tui/input", () => {
  test("matches plain shortcut keys", () => {
    expect(matchesShortcut("c", plainKey, "c")).toBe(true)
    expect(matchesShortcut("a", plainKey, "c")).toBe(false)
  })

  test("rejects modified shortcuts including Ctrl+C", () => {
    expect(matchesShortcut("c", { ...plainKey, ctrl: true }, "c")).toBe(false)
    expect(allowsShortcut({ ...plainKey, meta: true })).toBe(false)
    expect(allowsShortcut({ ...plainKey, super: true })).toBe(false)
    expect(allowsShortcut({ ...plainKey, hyper: true })).toBe(false)
  })

  test("ignores non-press kitty keyboard events", () => {
    expect(allowsShortcut({ ...plainKey, eventType: "release" })).toBe(false)
    expect(allowsShortcut({ ...plainKey, eventType: "press" })).toBe(true)
  })
})
