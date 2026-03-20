import { renderString, extractExprs } from "../workflow/expr"
import type { NodePath } from "../workflow/id"
import type { WorkflowDocument, WorkflowNode } from "../workflow/schema"
import { workflowById, type WorkflowProject } from "../project"
import { stepFailed, runError } from "./error"
import { normalizeInputs } from "./input"

export function findCallTarget(input: {
  activeWorkflowIds: string[]
  nodePath: NodePath
  project?: WorkflowProject | undefined
  step: WorkflowNode
}): WorkflowDocument | undefined {
  if (input.project === undefined) {
    return undefined
  }

  return resolveCallTarget({
    activeWorkflowIds: input.activeWorkflowIds,
    nodePath: input.nodePath,
    project: input.project,
    step: input.step,
  })
}

export function resolveCallTarget(input: {
  activeWorkflowIds: string[]
  nodePath: NodePath
  project: WorkflowProject
  step: WorkflowNode
}): WorkflowDocument {
  if (extractExprs(input.step.with.workflow).length > 0) {
    throw runError("workflow reference must be a static string, not a template expression.", {
      runReason: "validation_error",
    })
  }

  const workflow = workflowById(input.project, input.step.with.workflow)
  if (workflow === undefined) {
    throw runError(
      `Step \`${input.step.id ?? input.nodePath}\` references workflow \`${input.step.with.workflow}\` which does not exist. Available workflows: ${input.project.files
        .map((file) => file.workflow.id)
        .sort()
        .join(", ")}.`,
      {
        runReason: "validation_error",
      },
    )
  }

  if (input.activeWorkflowIds.includes(workflow.id)) {
    throw runError(
      `Step \`${input.step.id ?? input.nodePath}\` creates a circular workflow reference: ${[
        ...input.activeWorkflowIds,
        workflow.id,
      ].join(" -> ")}.`,
      {
        runReason: "validation_error",
      },
    )
  }

  return workflow
}

export function parseCallInputs(input: {
  inputs: Record<string, unknown>
  nodePath: NodePath
  step: WorkflowNode
  workflow: WorkflowDocument
}): Record<string, unknown> {
  const out = normalizeInputs(input.workflow, input.inputs)
  if (out.kind === "invalid") {
    throw runError(
      `Step \`${input.step.id ?? input.nodePath}\` cannot invoke workflow \`${input.workflow.id}\`: ${out.errors.join("; ")}`,
      {
        runReason: "validation_error",
      },
    )
  }

  return out.inputs
}

export function callEnv(
  env: Record<string, string | undefined>,
  workflow: WorkflowDocument,
  inputs: Record<string, unknown>,
): Record<string, string | undefined> {
  const next: Record<string, string | undefined> = {}

  for (const [key, value] of Object.entries(workflow.env ?? {})) {
    try {
      next[key] = renderString(value, {
        env,
        inputs,
        run: {},
        steps: {},
      })
    } catch (error) {
      throw stepFailed(error)
    }
  }

  return {
    ...env,
    ...next,
  }
}
