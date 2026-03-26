import { mkdir } from "node:fs/promises"
import { join } from "node:path"

import { normalizeError } from "../util/error"
import { examplesDoc, schemaDoc, syntaxDoc } from "./docs"
import { type CommandResult, failure, success } from "./result"
import { skillDoc } from "./skill"
import { branchTemplate, commitTemplate, implementTemplate, planTemplate, uncommittedTemplate } from "./templates"
import { writeIfMissing } from "./write"

async function writeInitialWorkspace(cwd: string): Promise<string[]> {
  const riggDir = join(cwd, ".rigg")
  const docsDir = join(riggDir, "docs")
  await mkdir(docsDir, { recursive: true })

  await Promise.all([
    writeIfMissing(join(riggDir, "implement.yaml"), implementTemplate),
    writeIfMissing(join(riggDir, "plan.yaml"), planTemplate),
    writeIfMissing(join(riggDir, "review-uncommitted.yaml"), uncommittedTemplate),
    writeIfMissing(join(riggDir, "review-branch.yaml"), branchTemplate),
    writeIfMissing(join(riggDir, "review-commit.yaml"), commitTemplate),
    writeIfMissing(join(docsDir, "workflow-syntax.md"), syntaxDoc),
    writeIfMissing(join(docsDir, "schema-reference.md"), schemaDoc),
    writeIfMissing(join(docsDir, "examples.md"), examplesDoc),
  ])

  await mkdir(join(cwd, ".agents/skills/rigg"), { recursive: true })
  await writeIfMissing(join(cwd, ".agents/skills/rigg/SKILL.md"), skillDoc)

  return [
    "Initialized .rigg/ with example workflows.",
    "Generated workflows: implement, plan, review-uncommitted, review-branch, review-commit.",
    "Generated .rigg/docs/ with workflow authoring documentation.",
    "Generated .agents/skills/rigg/ for AI-assisted workflow authoring.",
    "Examples:",
    "  rigg run implement --input requirements='...'",
    "  rigg run plan --input requirements='...' --input output_path=plan.md",
    "  rigg run review-uncommitted",
    "  rigg run review-branch --input base_branch=main",
    "  rigg run review-commit --input commit_sha=HEAD~1",
  ]
}

export async function runCommand(cwd: string): Promise<CommandResult> {
  try {
    return success(await writeInitialWorkspace(cwd))
  } catch (error) {
    return failure([normalizeError(error).message])
  }
}
