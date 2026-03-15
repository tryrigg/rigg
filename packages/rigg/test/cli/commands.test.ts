import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runInitCommand, runValidateCommand } from "../../src/cli/commands"
import { examplesDoc, schemaReferenceDoc, skillDoc, workflowSyntaxDoc } from "../../src/cli/docs"
import {
  planTemplate,
  reviewBranchTemplate,
  reviewCommitTemplate,
  reviewUncommittedTemplate,
} from "../../src/cli/templates"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

async function createTempWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rigg-cli-"))
  tempDirs.push(path)
  return path
}

describe("cli/commands", () => {
  test("init generates workflow, docs, and skill assets from packages/rigg", async () => {
    const cwd = await createTempWorkspace()

    const initResult = await runInitCommand(cwd)
    expect(initResult.exitCode).toBe(0)

    const validateResult = await runValidateCommand(cwd)
    expect(validateResult.exitCode).toBe(0)
    expect(validateResult.stdoutLines.join("\n")).toContain("plan")
    expect(validateResult.stdoutLines.join("\n")).toContain("review-uncommitted")
    expect(validateResult.stdoutLines.join("\n")).toContain("review-branch")
    expect(validateResult.stdoutLines.join("\n")).toContain("review-commit")

    expect(await readFile(join(cwd, ".rigg", "plan.yaml"), "utf8")).toBe(planTemplate)
    expect(await readFile(join(cwd, ".rigg", "review-uncommitted.yaml"), "utf8")).toBe(reviewUncommittedTemplate)
    expect(await readFile(join(cwd, ".rigg", "review-branch.yaml"), "utf8")).toBe(reviewBranchTemplate)
    expect(await readFile(join(cwd, ".rigg", "review-commit.yaml"), "utf8")).toBe(reviewCommitTemplate)

    expect(await readFile(join(cwd, ".rigg", "docs", "workflow-syntax.md"), "utf8")).toBe(workflowSyntaxDoc)
    expect(await readFile(join(cwd, ".rigg", "docs", "schema-reference.md"), "utf8")).toBe(schemaReferenceDoc)
    expect(await readFile(join(cwd, ".rigg", "docs", "examples.md"), "utf8")).toBe(examplesDoc)

    expect(await readFile(join(cwd, ".agents", "skills", "rigg", "SKILL.md"), "utf8")).toBe(skillDoc)

    await runInitCommand(cwd)
    expect(await Bun.file(join(cwd, ".gitignore")).exists()).toBe(false)
  })
})
