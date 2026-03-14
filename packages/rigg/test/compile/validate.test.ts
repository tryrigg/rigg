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
            done: "${{ steps.check.result.done }}",
            iteration: "${{ run.iteration }}",
          },
          id: "fix_loop",
          max: 2,
          steps: [
            {
              id: "check",
              type: "claude",
              with: {
                action: "prompt",
                output_schema: {
                  properties: {
                    done: { type: "boolean" },
                  },
                  required: ["done"],
                  type: "object",
                },
                prompt: "Evaluate",
              },
            },
          ],
          type: "loop",
          until: "${{ steps.check.result.done }}",
        },
        shellStep("echo ${{ steps.group_summary.result.summary }}"),
        shellStep("echo ${{ steps.fix_loop.result.done }}"),
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

  test("rejects run references outside loops", () => {
    const error = expectSingleError({
      id: "invalid-run",
      steps: [shellStep("echo ${{ run.iteration }}", "first")],
    })

    expect(error).toMatchObject({
      code: "reference_error",
      message: "`run.*` is only available inside loops.",
    })
  })

  test("requires whole wrapped expressions for control flow and exports", () => {
    const invalidIf = expectSingleError({
      id: "invalid-if",
      steps: [
        {
          if: "prefix ${{ true }}",
          type: "shell",
          with: { command: "echo hi" },
        },
      ],
    })
    const invalidUntil = expectSingleError({
      id: "invalid-until",
      steps: [
        {
          id: "retry",
          max: 2,
          steps: [shellStep("echo ok", "inner")],
          type: "loop",
          until: "${{ true }} suffix",
        },
      ],
    })
    const invalidExport = expectSingleError({
      id: "invalid-export",
      steps: [
        {
          exports: {
            summary: "prefix ${{ steps.inner.result }}",
          },
          id: "summary",
          steps: [shellStep("echo inner", "inner")],
          type: "group",
        },
      ],
    })

    expect(invalidIf?.message).toBe("Expected a whole `${{ ... }}` expression.")
    expect(invalidUntil?.message).toBe("Expected a whole `${{ ... }}` expression.")
    expect(invalidExport?.message).toBe("Expected a whole `${{ ... }}` expression.")
  })

  test("rejects forward step references", () => {
    const error = expectSingleError({
      id: "forward-ref",
      steps: [shellStep("echo ${{ steps.second.result }}", "first"), shellStep("echo later", "second")],
    })

    expect(error).toMatchObject({
      code: "reference_error",
      message: "Expression references step `second` before it is available.",
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
          type: "claude",
          with: {
            action: "prompt",
            output_schema: {
              additionalProperties: false,
              properties: {
                tags: {
                  items: { type: "string" },
                  type: "array",
                },
              },
              required: ["tags"],
              type: "object",
            },
            prompt: "Draft",
          },
        },
        shellStep("echo ${{ steps.draft.result.tags.foo }}"),
      ],
    })

    expect(invalidInput?.message).toBe("`inputs.config.missing` is not declared")
    expect(invalidRunField?.message).toBe("`run` only exposes `iteration`, `max_iterations`, and `node_path`")
    expect(invalidRunNested?.message).toBe("`run.iteration` does not support nested field access")
    expect(invalidStepRoot?.message).toBe("`steps.draft.status` is not available; use `steps.draft.result`")
    expect(invalidStepArray?.message).toBe("`steps.draft.result` array access must use a numeric index")
  })

  test("validates workflow env templates at compile time", () => {
    const error = expectSingleError({
      env: {
        BROKEN: "${{ steps.setup.result }}",
      },
      id: "invalid-workflow-env",
      steps: [shellStep("echo hi", "setup")],
    })

    expect(error).toMatchObject({
      code: "reference_error",
      message: "Expression references step `setup` before it is available.",
    })
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
    const elseNotLast = expectSingleError({
      id: "else-not-last",
      steps: [
        {
          cases: [
            {
              else: true,
              steps: [],
            },
            {
              if: "${{ true }}",
              steps: [shellStep("echo yes", "yes")],
            },
          ],
          id: "decide",
          type: "branch",
        },
      ],
    })

    expect(missingElse?.message).toBe("`branch` without `else` cannot declare case `exports`")
    expect(mismatchedExports?.message).toBe("all `branch` case exports must declare the same result shape")
    expect(elseNotLast?.message).toBe("`else` case must be the last branch case")
  })

  test("accepts integer and number as compatible branch export shapes", () => {
    expect(
      validateWorkspace(
        workflowProject([
          {
            workflow: {
              id: "branch-numeric-compat",
              steps: [
                {
                  cases: [
                    {
                      exports: { score: "${{ 1 }}" },
                      if: "${{ true }}",
                      steps: [],
                    },
                    {
                      else: true,
                      exports: { score: "${{ 1.5 }}" },
                      steps: [],
                    },
                  ],
                  id: "decide",
                  type: "branch",
                },
                shellStep("echo ${{ steps.decide.result.score }}"),
              ],
            },
          },
        ]),
      ),
    ).toEqual([])
  })

  test("hides conditional results from downstream steps", () => {
    const conditionalAction = expectSingleError({
      id: "conditional-action",
      steps: [
        {
          id: "maybe",
          if: "${{ true }}",
          type: "claude",
          with: {
            action: "prompt",
            output_schema: {
              properties: {
                accepted: { type: "boolean" },
              },
              required: ["accepted"],
              type: "object",
            },
            prompt: "Judge",
          },
        },
        shellStep("echo ${{ steps.maybe.result.accepted }}"),
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
    const conditionalParallel = expectSingleError({
      id: "conditional-parallel",
      steps: [
        {
          branches: [
            { id: "one", steps: [shellStep("echo one", "one")] },
            { id: "two", steps: [shellStep("echo two", "two")] },
          ],
          exports: { summary: "${{ steps.one.result }}" },
          id: "fanout",
          if: "${{ true }}",
          type: "parallel",
        },
        shellStep("echo ${{ steps.fanout.result.summary }}"),
      ],
    })

    expect(conditionalAction?.message).toBe("`steps.maybe.result` is not available for this node")
    expect(conditionalGroup?.message).toBe("`steps.summary.result` is not available for this node")
    expect(conditionalParallel?.message).toBe("`steps.fanout.result` is not available for this node")
  })

  test("rejects duplicate workflow ids and duplicate step ids", () => {
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

    expect(duplicateWorkflowErrors[0]).toMatchObject({
      code: "duplicate_workflow_id",
      filePath: "/workspace/.rigg/b.yaml",
      message: "Duplicate workflow id `dup`.",
    })
    expect(duplicateStepError).toMatchObject({
      code: "invalid_workflow",
      message: "Duplicate step id `repeat`.",
    })
  })

  test("rejects duplicate parallel branch ids and sibling conversation reuse", () => {
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
    const conversationConflict = expectSingleError({
      id: "conversation-conflict",
      steps: [
        {
          branches: [
            {
              id: "one",
              steps: [
                {
                  id: "draft_one",
                  type: "claude",
                  with: {
                    action: "prompt",
                    conversation: { name: "shared", scope: "workflow" },
                    prompt: "Draft",
                  },
                },
              ],
            },
            {
              id: "two",
              steps: [
                {
                  id: "draft_two",
                  type: "claude",
                  with: {
                    action: "prompt",
                    conversation: { name: "shared", scope: "workflow" },
                    prompt: "Draft",
                  },
                },
              ],
            },
          ],
          id: "checks",
          type: "parallel",
        },
      ],
    })

    expect(duplicateBranch?.message).toBe("`branches[1]` reuses local branch id `unit` within the same parallel node")
    expect(conversationConflict?.message).toBe(
      "`branches[1]` (`two`) cannot reuse a conversation binding already used by a sibling parallel branch",
    )
  })

  test("validates conversation scope and provider constraints", () => {
    const invalidScope = expectSingleError({
      id: "invalid-scope",
      steps: [
        {
          id: "draft",
          type: "claude",
          with: {
            action: "prompt",
            conversation: { name: "review", scope: "iteration" },
            prompt: "Draft",
          },
        },
      ],
    })
    const persistFalse = expectSingleError({
      id: "persist-false",
      steps: [
        {
          id: "draft",
          type: "claude",
          with: {
            action: "prompt",
            conversation: { name: "review" },
            persist: false,
            prompt: "Draft",
          },
        },
      ],
    })
    const providerReuse = expectSingleError({
      id: "provider-reuse",
      steps: [
        {
          id: "draft",
          type: "claude",
          with: {
            action: "prompt",
            conversation: { name: "review" },
            prompt: "Draft",
          },
        },
        {
          id: "edit",
          type: "codex",
          with: {
            action: "exec",
            conversation: { name: "review" },
            prompt: "Edit",
          },
        },
      ],
    })

    expect(invalidScope?.message).toBe("Conversation scope `iteration` can only be used inside loops.")
    expect(persistFalse?.message).toBe("`conversation` requires session persistence; remove `persist: false`")
    expect(providerReuse?.message).toBe(
      "`conversation: review` is already bound to `claude` and cannot be reused by `codex`",
    )
  })

  test("validates codex review target inference and codex resume restrictions", () => {
    const invalidTarget = expectSingleError({
      id: "invalid-target",
      steps: [
        {
          id: "review",
          type: "codex",
          with: {
            action: "review",
            commit: "abc123",
          },
        },
      ],
    })
    const resumeConflict = expectSingleError({
      id: "resume-conflict",
      steps: [
        {
          id: "first",
          type: "codex",
          with: {
            action: "exec",
            conversation: { name: "editor" },
            prompt: "Draft",
          },
        },
        {
          id: "second",
          type: "codex",
          with: {
            action: "exec",
            add_dirs: ["../shared"],
            conversation: { name: "editor" },
            output_schema: {
              properties: {
                status: { type: "string" },
              },
              required: ["status"],
              type: "object",
            },
            prompt: "Resume",
          },
        },
      ],
    })

    expect(invalidTarget?.message).toBe(
      "`review` requires exactly one of `target: uncommitted`, `target: base` with `base`, or `target: commit` with `commit`",
    )
    const baseInferredProject = workflowProject([
      {
        workflow: {
          id: "base-inferred",
          steps: [
            {
              id: "review",
              type: "codex",
              with: {
                action: "review",
                base: "main",
              },
            },
          ],
        },
      },
    ])
    expect(validateWorkspace(baseInferredProject)).toEqual([])
    expect(resumeConflict?.message).toBe(
      "`conversation` may resume a previous Codex session, but `codex exec resume` does not support `with.add_dirs`",
    )
    const outputSchemaConflictProject = workflowProject([
      {
        workflow: {
          id: "resume-schema-conflict",
          steps: [
            {
              id: "first",
              type: "codex",
              with: {
                action: "exec",
                conversation: { name: "editor" },
                prompt: "Draft",
              },
            },
            {
              id: "second",
              type: "codex",
              with: {
                action: "exec",
                conversation: { name: "editor" },
                output_schema: {
                  properties: {
                    status: { type: "string" },
                  },
                  required: ["status"],
                  type: "object",
                },
                prompt: "Resume",
              },
            },
          ],
        },
      },
    ])
    expect(validateWorkspace(outputSchemaConflictProject)[0]?.message).toBe(
      "`conversation` may resume a previous Codex session, but `codex exec resume` does not support `with.output_schema`",
    )
  })

  test("requires object output schemas for claude and codex exec", () => {
    const claudeError = expectSingleError({
      id: "claude-schema",
      steps: [
        {
          id: "judge",
          type: "claude",
          with: {
            action: "prompt",
            output_schema: { type: "string" },
            prompt: "Judge",
          },
        },
      ],
    })
    const codexError = expectSingleError({
      id: "codex-schema",
      steps: [
        {
          id: "edit",
          type: "codex",
          with: {
            action: "exec",
            output_schema: { type: "string" },
            prompt: "Edit",
          },
        },
      ],
    })

    expect(claudeError?.message).toBe("Claude `output_schema` must use `type: object`.")
    expect(codexError?.message).toBe("Codex exec `output_schema` must use `type: object`.")
  })
})
