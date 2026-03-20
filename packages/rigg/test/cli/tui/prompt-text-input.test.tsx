import { describe, expect, test } from "bun:test"
import { renderToString } from "ink"

import { PromptTextInput } from "../../../src/cli/tui/prompt-text-input"

describe("cli/tui/prompt-text-input", () => {
  test("renders multiline input without raw carriage returns", () => {
    const output = renderToString(
      <PromptTextInput focus={false} onChange={() => {}} onSubmit={() => {}} value={"hello\r\nworld"} />,
    )

    expect(output).toContain("hello")
    expect(output).toContain("world")
    expect(output).not.toContain("\r")
  })
})
