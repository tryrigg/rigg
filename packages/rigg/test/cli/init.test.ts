import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { examplesDoc, schemaDoc, syntaxDoc } from "../../src/cli/docs"
import { runCommand } from "../../src/cli/init"
import { skillDoc } from "../../src/cli/skill"
import { branchTemplate, commitTemplate, planTemplate, uncommittedTemplate } from "../../src/cli/templates"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

async function createTempWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rigg-cli-"))
  tempDirs.push(path)
  return path
}

describe("cli/init", () => {
  test("generates workflow, docs, and skill assets from packages/rigg", async () => {
    const cwd = await createTempWorkspace()

    const initResult = await runCommand(cwd)
    expect(initResult.exitCode).toBe(0)

    expect(await readFile(join(cwd, ".rigg", "plan.yaml"), "utf8")).toBe(planTemplate)
    expect(await readFile(join(cwd, ".rigg", "review-uncommitted.yaml"), "utf8")).toBe(uncommittedTemplate)
    expect(await readFile(join(cwd, ".rigg", "review-branch.yaml"), "utf8")).toBe(branchTemplate)
    expect(await readFile(join(cwd, ".rigg", "review-commit.yaml"), "utf8")).toBe(commitTemplate)

    expect(await readFile(join(cwd, ".rigg", "docs", "workflow-syntax.md"), "utf8")).toBe(syntaxDoc)
    expect(await readFile(join(cwd, ".rigg", "docs", "schema-reference.md"), "utf8")).toBe(schemaDoc)
    expect(await readFile(join(cwd, ".rigg", "docs", "examples.md"), "utf8")).toBe(examplesDoc)

    expect(await readFile(join(cwd, ".agents", "skills", "rigg", "SKILL.md"), "utf8")).toBe(skillDoc)

    await runCommand(cwd)
    expect(await Bun.file(join(cwd, ".gitignore")).exists()).toBe(false)
  })

  test("generated docs describe workflow composition", () => {
    expect(syntaxDoc).toContain("type: workflow")
    expect(syntaxDoc).toContain("steps.<workflow_step_id>.result` is `null` in v1")
    expect(schemaDoc).toContain("with.workflow")
    expect(schemaDoc).toContain("`with.workflow` must be a static string")
  })
})
