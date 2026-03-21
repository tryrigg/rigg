import { describe, expect, test } from "bun:test"

import { checkWorkspace } from "../../src/workflow/check"
import type { WorkflowDocument } from "../../src/workflow/schema"
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
  const [error] = checkWorkspace(workflowProject([{ workflow }]))
  expect(error).toBeDefined()
  return error
}

function expectSingleProjectError(project: ReturnType<typeof workflowProject>) {
  const [error] = checkWorkspace(project)
  expect(error).toBeDefined()
  return error
}

describe("workflow/check", () => {
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

    expect(checkWorkspace(workflowProject([{ workflow }]))).toEqual([])
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

  test("treats cursor results as plain text", () => {
    const error = expectSingleError({
      id: "cursor-text-only",
      steps: [
        {
          id: "triage",
          type: "cursor",
          with: {
            action: "run",
            prompt: "Return a summary",
          },
        },
        shellStep("echo ${{ steps.triage.result.findings }}"),
      ],
    })

    expect(error?.message).toBe("`steps.triage.result` does not support nested field access")
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

  test("accepts workflow steps and treats their result as null", () => {
    const project = workflowProject([
      {
        workflow: {
          id: "child",
          inputs: {
            count: { default: 1, type: "integer" },
            name: { type: "string" },
          },
          steps: [shellStep("echo ${{ inputs.name }}", "inner")],
        },
      },
      {
        workflow: {
          id: "parent",
          inputs: {
            name: { type: "string" },
          },
          steps: [
            {
              id: "call_child",
              type: "workflow",
              with: {
                inputs: {
                  count: 2,
                  name: "${{ inputs.name }}",
                },
                workflow: "child",
              },
            },
            shellStep("echo ${{ steps.call_child.result }}"),
          ],
        },
      },
    ])

    expect(checkWorkspace(project)).toEqual([])
  })

  test("does not expose nested workflow internal steps to the caller", () => {
    const error = expectSingleProjectError(
      workflowProject([
        {
          workflow: {
            id: "child",
            steps: [shellStep("echo hi", "inner")],
          },
        },
        {
          workflow: {
            id: "parent",
            steps: [
              {
                id: "call_child",
                type: "workflow",
                with: {
                  workflow: "child",
                },
              },
              shellStep("echo ${{ steps.inner.result }}"),
            ],
          },
        },
      ]),
    )

    expect(error?.message).toBe("Expression references step `inner` before it is available.")
  })

  test("validates workflow references, cycles, and nested input contracts", () => {
    const missingWorkflow = expectSingleProjectError(
      workflowProject([
        {
          workflow: {
            id: "parent",
            steps: [
              {
                id: "call_missing",
                type: "workflow",
                with: {
                  workflow: "missing",
                },
              },
            ],
          },
        },
      ]),
    )
    const unknownInput = expectSingleProjectError(
      workflowProject([
        {
          workflow: {
            id: "child",
            inputs: {
              name: { type: "string" },
            },
            steps: [shellStep("echo hi", "inner")],
          },
        },
        {
          workflow: {
            id: "parent",
            steps: [
              {
                id: "call_child",
                type: "workflow",
                with: {
                  inputs: {
                    extra: true,
                  },
                  workflow: "child",
                },
              },
            ],
          },
        },
      ]),
    )
    const missingRequiredInput = expectSingleProjectError(
      workflowProject([
        {
          workflow: {
            id: "child",
            inputs: {
              enabled: { type: "boolean" },
            },
            steps: [shellStep("echo hi", "inner")],
          },
        },
        {
          workflow: {
            id: "parent",
            steps: [
              {
                id: "call_child",
                type: "workflow",
                with: {
                  workflow: "child",
                },
              },
            ],
          },
        },
      ]),
    )
    const templateWorkflowRef = expectSingleProjectError(
      workflowProject([
        {
          workflow: {
            id: "parent",
            inputs: {
              target: { type: "string" },
            },
            steps: [
              {
                id: "call_child",
                type: "workflow",
                with: {
                  workflow: "${{ inputs.target }}",
                },
              },
            ],
          },
        },
      ]),
    )

    const cycleErrors = checkWorkspace(
      workflowProject([
        {
          workflow: {
            id: "a",
            steps: [
              {
                id: "call_b",
                type: "workflow",
                with: {
                  workflow: "b",
                },
              },
            ],
          },
        },
        {
          workflow: {
            id: "b",
            steps: [
              {
                id: "call_a",
                type: "workflow",
                with: {
                  workflow: "a",
                },
              },
            ],
          },
        },
      ]),
    )

    expect(missingWorkflow?.message).toBe(
      "Step `call_missing` references workflow `missing` which does not exist. Available workflows: parent.",
    )
    expect(unknownInput?.message).toBe(
      "Step `call_child` provides input `extra` which is not declared by workflow `child`. Declared inputs: name.",
    )
    expect(missingRequiredInput?.message).toBe(
      "Step `call_child` does not provide required input `enabled` for workflow `child`.",
    )
    expect(templateWorkflowRef?.message).toBe("workflow reference must be a static string, not a template expression.")
    expect(
      cycleErrors.some(
        (error) => error.message === "Step `call_a` creates a circular workflow reference: a -> b -> a.",
      ),
    ).toBe(true)
  })

  test("accepts template and literal workflow inputs", () => {
    const project = workflowProject([
      {
        workflow: {
          id: "child",
          inputs: {
            count: { type: "integer" },
            enabled: { type: "boolean" },
            mode: { type: "string" },
            name: { type: "string" },
          },
          steps: [shellStep("echo hi", "inner")],
        },
      },
      {
        workflow: {
          id: "parent",
          inputs: {
            mode: { type: "string" },
          },
          steps: [
            {
              id: "call_child",
              type: "workflow",
              with: {
                inputs: {
                  count: 3,
                  enabled: true,
                  mode: "${{ inputs.mode }}",
                  name: "literal",
                },
                workflow: "child",
              },
            },
          ],
        },
      },
    ])

    expect(checkWorkspace(project)).toEqual([])
  })

  test("accepts dynamically typed json workflow inputs", () => {
    const project = workflowProject([
      {
        workflow: {
          id: "child",
          inputs: {
            config: {
              properties: {
                enabled: { type: "boolean" },
              },
              required: ["enabled"],
              type: "object",
            },
            count: { type: "integer" },
          },
          steps: [shellStep("echo hi", "inner")],
        },
      },
      {
        workflow: {
          id: "parent",
          steps: [
            {
              id: "fetch",
              type: "shell",
              with: {
                command: 'echo \'{"count": 3, "config": {"enabled": true}}\'',
                result: "json",
              },
            },
            {
              id: "call_child",
              type: "workflow",
              with: {
                inputs: {
                  config: "${{ steps.fetch.result.config }}",
                  count: "${{ steps.fetch.result.count }}",
                },
                workflow: "child",
              },
            },
          ],
        },
      },
    ])

    expect(checkWorkspace(project)).toEqual([])
  })

  test("accepts interpolated workflow inputs that normalize to json", () => {
    const project = workflowProject([
      {
        workflow: {
          id: "child",
          inputs: {
            config: {
              properties: {
                enabled: { type: "boolean" },
              },
              required: ["enabled"],
              type: "object",
            },
            count: { type: "integer" },
          },
          steps: [shellStep("echo hi", "inner")],
        },
      },
      {
        workflow: {
          id: "parent",
          steps: [
            {
              id: "call_child",
              type: "workflow",
              with: {
                inputs: {
                  config: '{"enabled": ${{ true }}}',
                  count: "12",
                },
                workflow: "child",
              },
            },
          ],
        },
      },
    ])

    expect(checkWorkspace(project)).toEqual([])
  })

  test("rejects dynamic mixed templates for typed workflow inputs", () => {
    const project = workflowProject([
      {
        workflow: {
          id: "child",
          inputs: {
            count: { type: "integer" },
          },
          steps: [shellStep("echo hi", "inner")],
        },
      },
      {
        workflow: {
          id: "parent",
          inputs: {
            delta: { type: "integer" },
          },
          steps: [
            {
              id: "call_child",
              type: "workflow",
              with: {
                inputs: {
                  count: "count=${{ inputs.delta }}",
                },
                workflow: "child",
              },
            },
          ],
        },
      },
    ])

    expect(checkWorkspace(project).map((error) => error.message)).toContain(
      "Step `call_child` input `count` for workflow `child` expects a integer value, but mixed templates with dynamic expressions can only guarantee string output. Use a whole `${{ ... }}` expression instead.",
    )
  })

  test("accepts workflow object inputs with additionalProperties", () => {
    const project = workflowProject([
      {
        workflow: {
          id: "child",
          inputs: {
            config: {
              additionalProperties: true,
              properties: {
                enabled: { type: "boolean" },
              },
              required: ["enabled"],
              type: "object",
            },
          },
          steps: [shellStep("echo hi", "inner")],
        },
      },
      {
        workflow: {
          id: "parent",
          steps: [
            {
              id: "fetch",
              type: "shell",
              with: {
                command: 'echo \'{"enabled": true, "extra": "value"}\'',
                result: "json",
              },
            },
            {
              id: "call_child",
              type: "workflow",
              with: {
                inputs: {
                  config: "${{ steps.fetch.result }}",
                },
                workflow: "child",
              },
            },
          ],
        },
      },
    ])

    expect(checkWorkspace(project)).toEqual([])
  })

  test("rejects duplicate workflow ids, duplicate step ids, and duplicate parallel branch ids", () => {
    const duplicateWorkflowErrors = checkWorkspace(
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
      checkWorkspace(
        workflowProject([
          {
            workflow: {
              id: "review-targets",
              steps: [
                {
                  id: "plan",
                  type: "codex",
                  with: {
                    action: "plan",
                    prompt: "Clarify scope and propose a plan.",
                  },
                },
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
