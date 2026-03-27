import { describe, expect, test } from "bun:test"

import { statusSymbol, kindColor, formatDuration } from "../../../src/cli/tui/symbols"

describe("statusSymbol", () => {
  test("returns correct colors for each status", () => {
    expect(statusSymbol("not_started").color).toBe("dim")
    expect(statusSymbol("pending").color).toBe("dim")
    expect(statusSymbol("running").color).toBe("cyan")
    expect(statusSymbol("retrying").color).toBe("cyan")
    expect(statusSymbol("succeeded").color).toBe("green")
    expect(statusSymbol("failed").color).toBe("red")
    expect(statusSymbol("aborted").color).toBe("yellow")
    expect(statusSymbol("skipped").color).toBe("dim")
    expect(statusSymbol("interrupted").color).toBe("cyan")
    expect(statusSymbol("waiting_for_interaction").color).toBe("yellow")
  })

  test("returns non-empty icons for each status", () => {
    const statuses = [
      "not_started",
      "pending",
      "running",
      "retrying",
      "succeeded",
      "failed",
      "aborted",
      "skipped",
      "interrupted",
      "waiting_for_interaction",
    ] as const
    for (const status of statuses) {
      expect(statusSymbol(status).icon.length).toBeGreaterThan(0)
    }
  })
})

describe("kindColor", () => {
  test("returns a color string for known kinds", () => {
    expect(kindColor("shell")).toBeTruthy()
    expect(kindColor("codex")).toBeTruthy()
    expect(kindColor("write_file")).toBeTruthy()
  })

  test("returns dim for structural kinds", () => {
    expect(kindColor("group")).toBe("dim")
    expect(kindColor("parallel")).toBe("dim")
    expect(kindColor("branch")).toBe("dim")
    expect(kindColor("branch_case")).toBe("dim")
  })

  test("returns cyan for loop kind", () => {
    expect(kindColor("loop")).toBe("cyan")
  })

  test("returns dim for unknown kinds", () => {
    expect(kindColor("unknown")).toBe("dim")
  })
})

describe("formatDuration", () => {
  test("formats milliseconds below 1000", () => {
    expect(formatDuration(500)).toBe("500ms")
    expect(formatDuration(0)).toBe("0ms")
    expect(formatDuration(999)).toBe("999ms")
  })

  test("formats seconds", () => {
    expect(formatDuration(1000)).toBe("1.0s")
    expect(formatDuration(1500)).toBe("1.5s")
    expect(formatDuration(12300)).toBe("12.3s")
    expect(formatDuration(60000)).toBe("1m 00s")
    expect(formatDuration(64000)).toBe("1m 04s")
    expect(formatDuration(4_320_000)).toBe("1h 12m")
  })
})
