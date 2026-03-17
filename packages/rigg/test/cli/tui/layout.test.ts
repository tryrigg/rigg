import { describe, expect, test } from "bun:test"

import { layoutHeaderLine, renderRule } from "../../../src/cli/tui/layout"

function renderHeader(layout: ReturnType<typeof layoutHeaderLine>): string {
  const right = layout.elapsedText.length > 0 ? `${layout.elapsedText} ${layout.statusText}` : layout.statusText
  return `${layout.left}${" ".repeat(layout.gap)}${right}`.trimEnd()
}

describe("layoutHeaderLine", () => {
  test("keeps header content inside the terminal width budget", () => {
    const layout = layoutHeaderLine({
      cols: 40,
      elapsed: "01:08",
      status: "running",
      workflowId: "plan",
    })

    const rendered = renderHeader(layout)
    expect(rendered.length).toBeLessThanOrEqual(38)
  })

  test("truncates long workflow ids before the right status block wraps", () => {
    const layout = layoutHeaderLine({
      cols: 32,
      elapsed: "01:08",
      status: "running",
      workflowId: "very-long-workflow-id",
    })

    expect(layout.left).toBe("rigg very-lon...")
    expect(layout.gap).toBeGreaterThanOrEqual(1)
  })

  test("drops left content before exceeding the width budget on very narrow terminals", () => {
    const layout = layoutHeaderLine({
      cols: 20,
      elapsed: "01:08",
      status: "running",
      workflowId: "plan",
    })

    const rendered = renderHeader(layout)
    expect(rendered.length).toBeLessThanOrEqual(18)
    expect(rendered).toBe("rigg 01:08 running")
  })

  test("keeps status visible when the full right block does not fit", () => {
    const layout = layoutHeaderLine({
      cols: 12,
      elapsed: "01:08",
      status: "running",
      workflowId: "plan",
    })

    const rendered = renderHeader(layout).trim()
    expect(rendered.length).toBeLessThanOrEqual(10)
    expect(rendered).toBe("ri running")
  })

  test("keeps the waiting header inside the width budget", () => {
    const layout = layoutHeaderLine({
      cols: 12,
      elapsed: "",
      status: "waiting",
      workflowId: "",
    })

    const rendered = renderHeader(layout).trim()
    expect(rendered.length).toBeLessThanOrEqual(10)
    expect(rendered).toBe("ri waiting")
  })
})

describe("renderRule", () => {
  test("leaves terminal safety columns instead of filling the last cell", () => {
    expect(renderRule(12)).toBe("  --------")
  })
})
