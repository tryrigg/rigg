import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { runInitCommand, runLogsCommand, runStatusCommand, runValidateCommand } from "../../src/cli/commands"
import { examplesDoc, schemaReferenceDoc, skillDoc, workflowSyntaxDoc } from "../../src/cli/docs"
import {
  planTemplate,
  reviewBranchTemplate,
  reviewCommitTemplate,
  reviewUncommittedTemplate,
} from "../../src/cli/templates"
import { formatLogPath } from "../../src/history"
import { stringifyJson } from "../../src/util/json"
import { runSnapshot } from "../fixture/builders"

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
    expect(await readFile(join(cwd, ".claude", "skills", "rigg", "SKILL.md"), "utf8")).toBe(skillDoc)

    await runInitCommand(cwd)
    expect(await readFile(join(cwd, ".gitignore"), "utf8")).toBe("/.rigg/runs/\n")
  })

  test("status renders snapshots discovered from parent directories", async () => {
    const cwd = await createTempWorkspace()
    const nestedDir = join(cwd, "packages", "rigg")
    const runId = "019cc300-0000-7000-8000-000000000123"
    const runDir = join(cwd, ".rigg", "runs", runId)
    await mkdir(join(runDir, "logs"), { recursive: true })
    await mkdir(nestedDir, { recursive: true })

    await Bun.write(
      join(runDir, "state.json"),
      stringifyJson(
        runSnapshot({
          nodes: [
            {
              attempt: 1,
              duration_ms: 1500,
              exit_code: 1,
              finished_at: "2026-03-14T00:00:02.000Z",
              node_path: "/0",
              result: null,
              started_at: "2026-03-14T00:00:00.500Z",
              status: "failed",
              stderr: null,
              stderr_path: null,
              stderr_preview: "boom",
              stdout: null,
              stdout_path: null,
              stdout_preview: "checking",
              user_id: "lint",
            },
          ],
          run_id: runId,
          reason: "step_failed",
          status: "failed",
          workflow_id: "review-uncommitted",
        }),
      ),
    )

    const result = await runStatusCommand(nestedDir)
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines).toContain(`${runId}  review-uncommitted  Failed`)
    expect(result.stdoutLines).toContain("  lint             Failed exit=1")
  })

  test("logs resolves user ids and renders matching stdout logs", async () => {
    const cwd = await createTempWorkspace()
    const runId = "019cc300-0000-7000-8000-000000000123"
    const runDir = join(cwd, ".rigg", "runs", runId)
    const relativeLogPath = formatLogPath("root", "/0", 1, "stdout")
    const absoluteLogPath = join(runDir, relativeLogPath)
    await mkdir(dirname(absoluteLogPath), { recursive: true })

    await Bun.write(
      join(runDir, "state.json"),
      stringifyJson(
        runSnapshot({
          nodes: [
            {
              attempt: 1,
              duration_ms: 0,
              exit_code: 0,
              finished_at: "2026-03-14T00:00:02.000Z",
              node_path: "/0",
              result: null,
              started_at: "2026-03-14T00:00:00.500Z",
              status: "succeeded",
              stderr: null,
              stderr_path: null,
              stderr_preview: "",
              stdout: null,
              stdout_path: relativeLogPath,
              stdout_preview: "hello",
              user_id: "lint",
            },
          ],
          finished_at: "2026-03-14T00:00:02.000Z",
          reason: "completed",
          run_id: runId,
          status: "succeeded",
        }),
      ),
    )
    await Bun.write(absoluteLogPath, "hello from stdout\n")

    const result = await runLogsCommand(cwd, runId, { node: "lint", stderr: false })
    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines.join("\n")).toContain("frame=root.path=s00000001_0.attempt-1.stdout.log")
    expect(result.stdoutLines.join("\n")).toContain("hello from stdout")
  })
})
