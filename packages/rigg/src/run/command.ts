import type { WorkflowProject } from "../compile/index"
import { workflowById } from "../compile/project"
import type { RunProgressEvent } from "./progress"
import type { RunSnapshot } from "./schema"
import { executeWorkflow } from "./execute"
import { normalizeInvocationInputs } from "./plan"

export type RunWorkflowResult =
  | { kind: "completed"; snapshot: RunSnapshot }
  | { kind: "workflow_not_found"; message: string }
  | { kind: "invalid_input"; errors: string[] }

export async function runWorkflowCommand(options: {
  invocationInputs: Record<string, unknown>
  onProgress?: ((event: RunProgressEvent) => void) | undefined
  parentEnv: Record<string, string | undefined>
  project: WorkflowProject
  workflowId: string
}): Promise<RunWorkflowResult> {
  const workflow = workflowById(options.project, options.workflowId)
  if (workflow === undefined) {
    return {
      kind: "workflow_not_found",
      message: `Workflow "${options.workflowId}" was not found.`,
    }
  }

  const inputs = normalizeInvocationInputs(workflow, options.invocationInputs)
  if (inputs.kind === "invalid") {
    return { kind: "invalid_input", errors: inputs.errors }
  }

  return {
    kind: "completed",
    snapshot: await executeWorkflow({
      invocationInputs: inputs.inputs,
      onProgress: options.onProgress,
      parentEnv: options.parentEnv,
      projectRoot: options.project.workspace.rootDir,
      workflow,
    }),
  }
}
