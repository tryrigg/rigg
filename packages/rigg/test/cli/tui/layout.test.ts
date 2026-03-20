import { describe, expect, test } from "bun:test"

import { headerLine, renderRule } from "../../../src/cli/tui/layout"

function renderHeader(layout: ReturnType<typeof headerLine>): string {
  const right = layout.elapsedText.length > 0 ? `${layout.elapsedText} ${layout.statusText}` : layout.statusText
  return `${layout.left}${" ".repeat(layout.gap)}${right}`.trimEnd()
}

describe("headerLine", () => {
  test("keeps header content inside the terminal width budget", () => {
    const layout = headerLine({
      cols: 40,
      elapsed: "01:08",
      status: "running",
      workflowId: "plan",
    })

    const rendered = renderHeader(layout)
    expect(rendered.length).toBeLessThanOrEqual(38)
  })

  test("truncates long workflow ids before the right status block wraps", () => {
    const layout = headerLine({
      cols: 36,
      elapsed: "01:08",
      status: "running",
      workflowId: "very-long-workflow-id",
    })

    expect(layout.left).toContain("rigg")
    expect(layout.gap).toBeGreaterThanOrEqual(1)
  })

  test("shows step progress when it exactly fits the left header budget", () => {
    const layout = headerLine({
      cols: 36,
      elapsed: "00:01",
      status: "running",
      stepProgress: "0/9 steps",
      workflowId: "wf",
    })

    const rendered = renderHeader(layout)
    expect(rendered.length).toBeLessThanOrEqual(34)
    expect(layout.left).toContain("0/9 steps")
  })

  test("drops left content before exceeding the width budget on very narrow terminals", () => {
    const layout = headerLine({
      cols: 24,
      elapsed: "01:08",
      status: "running",
      workflowId: "plan",
    })

    const rendered = renderHeader(layout)
    expect(rendered.length).toBeLessThanOrEqual(22)
    expect(rendered).toContain("rigg")
    expect(rendered).toContain("running")
  })

  test("keeps status visible when the full right block does not fit", () => {
    const layout = headerLine({
      cols: 16,
      elapsed: "01:08",
      status: "running",
      workflowId: "plan",
    })

    const rendered = renderHeader(layout).trim()
    expect(rendered.length).toBeLessThanOrEqual(14)
    expect(rendered).toContain("running")
  })

  test("keeps the waiting header inside the width budget", () => {
    const layout = headerLine({
      cols: 16,
      elapsed: "",
      status: "waiting",
      workflowId: "",
    })

    const rendered = renderHeader(layout).trim()
    expect(rendered.length).toBeLessThanOrEqual(14)
    expect(rendered).toContain("waiting")
  })
})

describe("renderRule", () => {
  test("leaves terminal safety columns instead of filling the last cell", () => {
    expect(renderRule(12)).toBe("  ────────")
  })
})
