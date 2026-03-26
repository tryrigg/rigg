import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { renderHelp } from "../../src/cli/args"

function helpCommands(): string[] {
  const lines = renderHelp()
  const start = lines.indexOf("Commands:")
  const end = lines.indexOf("", start)
  return lines
    .slice(start + 1, end)
    .map((line) => line.trim())
    .filter(Boolean)
}

describe("cli docs", () => {
  test("CLI reference mentions every command shown in help", () => {
    const path = resolve(import.meta.dir, "../../../www/src/content/docs/docs/reference/cli.mdx")
    const doc = readFileSync(path, "utf8")

    for (const command of helpCommands()) {
      const commandName = command.split(" ")[0]
      expect(doc).toContain(`## rigg ${commandName}`)
    }
  })
})
