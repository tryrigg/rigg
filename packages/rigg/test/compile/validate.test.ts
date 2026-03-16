import { describe, expect, test } from "bun:test"

import { validateWorkspace } from "../../src/compile/validate"
import type { WorkflowDocument } from "../../src/compile/schema"
import { workflowProject } from "../fixture/builders"

function shellStep(command: string, id?: string) {
  return {
    ...(id === undefined ? {} : { id }),
    type: "shell" as const,
    with: {
      command,
    },
  }
}

function expectSingleError(workflow: WorkflowDocument) {
  const [error] = validateWorkspace(workflowProject([{ workflow }]))
  expect(error).toBeDefined()
  return error
}

describe("compile/validate", () => {
  test("accepts group and loop exports for downstream access", () => {
    const workflow: WorkflowDocument = {
      id: "control-flow",
      steps: [
        {
          exports: {
            summary: "${{ steps.inner.result }}",
          },
          id: "group_summary",
          steps: [shellStep("echo inner", "inner")],
          type: "group",
        },
        {
          exports: {
            iteration: "${{ run.iteration }}",
            summary: "${{ steps.check.result }}",
          },
          id: "fix_loop",
          max: 2,
          steps: [
            {
              id: "check",
              type: "codex",
              with: {
                action: "run",
                prompt: "Evaluate",
              },
            },
          ],
          type: "loop",
          until: "${{ run.iteration == 1 }}",
        },
        shellStep("echo ${{ steps.group_summary.result.summary }}"),
        shellStep("echo ${{ steps.fix_loop.result.summary }}"),
      ],
    }

    expect(validateWorkspace(workflowProject([{ workflow }]))).toEqual([])
  })

  test("hides group internals from downstream steps without exports", () => {
    const error = expectSingleError({
      id: "group-private",
      steps: [
        {
          exports: {
            summary: "${{ steps.inner.result }}",
          },
          id: "summary",
          steps: [shellStep("echo inner", "inner")],
          type: "group",
        },
        shellStep("echo ${{ steps.inner.result }}"),
      ],
    })

    expect(error).toMatchObject({
      code: "reference_error",
      message: "Expression references step `inner` before it is available.",
    })
  })

  test("rejects invalid input, run, and step reference shapes", () => {
    const invalidInput = expectSingleError({
      id: "invalid-input-ref",
      inputs: {
        config: {
          properties: {
            retries: { type: "integer" },
          },
          required: ["retries"],
          type: "object",
        },
      },
      steps: [shellStep("echo ${{ inputs.config.missing }}")],
    })
    const invalidRunField = expectSingleError({
      id: "invalid-run-field",
      steps: [
        {
          id: "loop",
          max: 2,
          steps: [shellStep("echo ok", "inner")],
          type: "loop",
          until: "${{ run.foo }}",
        },
      ],
    })
    const invalidRunNested = expectSingleError({
      id: "invalid-run-nested",
      steps: [
        {
          id: "loop",
          max: 2,
          steps: [shellStep("echo ok", "inner")],
          type: "loop",
          until: "${{ run.iteration.value }}",
        },
      ],
    })
    const invalidStepRoot = expectSingleError({
      id: "invalid-step-root",
      steps: [shellStep("echo hi", "draft"), shellStep("echo ${{ steps.draft.status }}")],
    })
    const invalidStepArray = expectSingleError({
      id: "invalid-step-array",
      steps: [
        {
          id: "draft",
          type: "codex",
          with: {
            action: "review",
            review: {
              target: {
                type: "uncommitted",
              },
            },
          },
        },
        shellStep("echo ${{ steps.draft.result.findings.foo }}"),
      ],
    })

    expect(invalidInput?.message).toBe("`inputs.config.missing` is not declared")
    expect(invalidRunField?.message).toBe("`run` only exposes `iteration`, `max_iterations`, and `node_path`")
    expect(invalidRunNested?.message).toBe("`run.iteration` does not support nested field access")
    expect(invalidStepRoot?.message).toBe("`steps.draft.status` is not available; use `steps.draft.result`")
    expect(invalidStepArray?.message).toBe("`steps.draft.result` array access must use a numeric index")
  })

  test("validates branch else rules and export shape consistency", () => {
    const missingElse = expectSingleError({
      id: "missing-else",
      steps: [
        {
          cases: [
            {
              exports: { result: "${{ 'yes' }}" },
              if: "${{ true }}",
              steps: [shellStep("echo yes", "yes")],
            },
          ],
          id: "decide",
          type: "branch",
        },
      ],
    })
    const mismatchedExports = expectSingleError({
      id: "mismatched-else",
      steps: [
        {
          cases: [
            {
              exports: { result: "${{ 'yes' }}" },
              if: "${{ true }}",
              steps: [shellStep("echo yes", "yes")],
            },
            {
              else: true,
              exports: { result: "${{ 1 }}" },
              steps: [],
            },
          ],
          id: "decide",
          type: "branch",
        },
      ],
    })

    expect(missingElse?.message).toBe("`branch` without `else` cannot declare case `exports`")
    expect(mismatchedExports?.message).toBe("all `branch` case exports must declare the same result shape")
  })

  test("hides conditional results from downstream steps", () => {
    const conditionalAction = expectSingleError({
      id: "conditional-action",
      steps: [
        {
          id: "maybe",
          if: "${{ true }}",
          type: "codex",
          with: {
            action: "run",
            prompt: "Judge",
          },
        },
        shellStep("echo ${{ steps.maybe.result }}"),
      ],
    })
    const conditionalGroup = expectSingleError({
      id: "conditional-group",
      steps: [
        {
          exports: { summary: "${{ steps.inner.result }}" },
          id: "summary",
          if: "${{ true }}",
          steps: [shellStep("echo inner", "inner")],
          type: "group",
        },
        shellStep("echo ${{ steps.summary.result.summary }}"),
      ],
    })

    expect(conditionalAction?.message).toBe("`steps.maybe.result` is not available for this node")
    expect(conditionalGroup?.message).toBe("`steps.summary.result` is not available for this node")
  })

  test("rejects duplicate workflow ids, duplicate step ids, and duplicate parallel branch ids", () => {
    const duplicateWorkflowErrors = validateWorkspace(
      workflowProject([
        {
          filePath: "/workspace/.rigg/a.yaml",
          workflow: {
            id: "dup",
            steps: [shellStep("echo a")],
          },
        },
        {
          filePath: "/workspace/.rigg/b.yaml",
          workflow: {
            id: "dup",
            steps: [shellStep("echo b")],
          },
        },
      ]),
    )
    const duplicateStepError = expectSingleError({
      id: "duplicate-step",
      steps: [shellStep("echo a", "repeat"), shellStep("echo b", "repeat")],
    })
    const duplicateBranch = expectSingleError({
      id: "duplicate-branch",
      steps: [
        {
          branches: [
            { id: "unit", steps: [shellStep("echo unit", "run_unit")] },
            { id: "unit", steps: [shellStep("echo lint", "run_lint")] },
          ],
          id: "checks",
          type: "parallel",
        },
      ],
    })

    expect(duplicateWorkflowErrors[0]).toMatchObject({
      code: "duplicate_workflow_id",
      filePath: "/workspace/.rigg/b.yaml",
      message: "Duplicate workflow id `dup`.",
    })
    expect(duplicateStepError).toMatchObject({
      code: "invalid_workflow",
      message: "Duplicate step id `repeat`.",
    })
    expect(duplicateBranch?.message).toBe("`branches[1]` reuses local branch id `unit` within the same parallel node")
  })

  test("validates codex review targets", () => {
    expect(
      validateWorkspace(
        workflowProject([
          {
            workflow: {
              id: "review-targets",
              steps: [
                {
                  id: "uncommitted",
                  type: "codex",
                  with: {
                    action: "review",
                    review: {
                      target: { type: "uncommitted" },
                    },
                  },
                },
                {
                  id: "base",
                  type: "codex",
                  with: {
                    action: "review",
                    review: {
                      target: { branch: "main", type: "base" },
                    },
                  },
                },
                {
                  id: "commit",
                  type: "codex",
                  with: {
                    action: "review",
                    review: {
                      target: { sha: "abc123", type: "commit" },
                    },
                  },
                },
              ],
            },
          },
        ]),
      ),
    ).toEqual([])
  })
})
