import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runInitCommand } from "../../src/cli/init"
import { runValidateCommand } from "../../src/cli/validate"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

async function createTempWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rigg-cli-"))
  tempDirs.push(path)
  return path
}

describe("cli/validate", () => {
  test("reports discovered workflows in plain text", async () => {
    const cwd = await createTempWorkspace()
    await runInitCommand(cwd)

    const result = await runValidateCommand(cwd)
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines.join("\n")).toContain("plan")
    expect(result.stdoutLines.join("\n")).toContain("review-uncommitted")
    expect(result.stdoutLines.join("\n")).toContain("review-branch")
    expect(result.stdoutLines.join("\n")).toContain("review-commit")
  })

  test("renders machine-readable json output", async () => {
    const cwd = await createTempWorkspace()
    await runInitCommand(cwd)

    const result = await runValidateCommand(cwd, true)
    expect(result.exitCode).toBe(0)

    const payload = JSON.parse(result.stdoutLines[0] ?? "{}") as {
      config_files: string[]
      ok: boolean
      project_root: string
      workflows: string[]
    }

    expect(payload.ok).toBe(true)
    expect(payload.project_root).toBe(cwd)
    expect(payload.workflows).toContain("plan")
    expect(payload.config_files.some((file) => file.endsWith("/.rigg/plan.yaml"))).toBe(true)
  })
})
