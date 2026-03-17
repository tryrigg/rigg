import { describe, expect, test } from "bun:test"

import { statusSymbol, formatDuration } from "../../../src/cli/tui/symbols"

describe("statusSymbol", () => {
  test("returns correct colors for each status", () => {
    expect(statusSymbol("not_started").color).toBe("dim")
    expect(statusSymbol("pending").color).toBe("dim")
    expect(statusSymbol("running").color).toBe("cyan")
    expect(statusSymbol("succeeded").color).toBe("green")
    expect(statusSymbol("failed").color).toBe("red")
    expect(statusSymbol("skipped").color).toBe("dim")
    expect(statusSymbol("interrupted").color).toBe("cyan")
    expect(statusSymbol("waiting_for_interaction").color).toBe("cyan")
  })

  test("returns non-empty icons for each status", () => {
    const statuses = [
      "not_started",
      "pending",
      "running",
      "succeeded",
      "failed",
      "skipped",
      "interrupted",
      "waiting_for_interaction",
    ] as const
    for (const status of statuses) {
      expect(statusSymbol(status).icon.length).toBeGreaterThan(0)
    }
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
    expect(formatDuration(60000)).toBe("60.0s")
  })
})
