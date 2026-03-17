import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createWorkflowInterruptController,
  runInitCommand,
  runRunCommand,
  runValidateCommand,
} from "../../src/cli/commands"
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

function withTTYState(tty: { stderr: boolean; stdin: boolean }, run: () => Promise<void> | void): Promise<void> | void {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
  const stderrDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY")

  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: tty.stdin })
  Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: tty.stderr })

  const restore = () => {
    if (stdinDescriptor === undefined) {
      delete (process.stdin as { isTTY?: boolean }).isTTY
    } else {
      Object.defineProperty(process.stdin, "isTTY", stdinDescriptor)
    }
    if (stderrDescriptor === undefined) {
      delete (process.stderr as { isTTY?: boolean }).isTTY
    } else {
      Object.defineProperty(process.stderr, "isTTY", stderrDescriptor)
    }
  }

  try {
    const result = run()
    if (result instanceof Promise) {
      return result.finally(restore)
    }
    restore()
    return result
  } catch (error) {
    restore()
    throw error
  }
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

  test("run requires interactive stdin and stderr", async () => {
    const cwd = await createTempWorkspace()
    await runInitCommand(cwd)

    await withTTYState({ stderr: true, stdin: false }, async () => {
      const result = await runRunCommand(cwd, "plan", { inputs: [] })
      expect(result.exitCode).toBe(1)
      expect(result.stderrLines.join("\n")).toContain("interactive terminal")
    })
  })

  test("workflow interrupt controller aborts first and hard-exits on second interrupt", () => {
    const originalKill = process.kill
    let killCount = 0

    ;(process as { kill: typeof process.kill }).kill = ((pid: number, signal?: number | NodeJS.Signals) => {
      expect(pid).toBe(process.pid)
      expect(signal).toBe("SIGINT")
      killCount += 1
      return true
    }) as typeof process.kill

    try {
      const interrupt = createWorkflowInterruptController()
      interrupt.interrupt()
      expect(interrupt.signal.aborted).toBe(true)

      interrupt.interrupt()
      expect(killCount).toBe(1)
      interrupt.dispose()
    } finally {
      ;(process as { kill: typeof process.kill }).kill = originalKill
    }
  })
})
