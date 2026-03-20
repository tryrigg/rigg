import type { WorkflowProject } from "../compile/index"
import { workflowById } from "../compile/project"
import type { RunControlHandler, RunEvent } from "./progress"
import type { RunSnapshot } from "./schema"
import { executeWorkflow } from "./execute"
import { normalizeInvocationInputs } from "./invocation"

export type RunWorkflowResult =
  | { kind: "completed"; snapshot: RunSnapshot }
  | { kind: "workflow_not_found"; message: string }
  | { kind: "invalid_input"; errors: string[] }

export async function runWorkflowCommand(options: {
  controlHandler: RunControlHandler
  invocationInputs: Record<string, unknown>
  onEvent?: ((event: RunEvent) => void) | undefined
  parentEnv: Record<string, string | undefined>
  project: WorkflowProject
  signal?: AbortSignal | undefined
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
      controlHandler: options.controlHandler,
      invocationInputs: inputs.inputs,
      onEvent: options.onEvent,
      parentEnv: options.parentEnv,
      project: options.project,
      projectRoot: options.project.workspace.rootDir,
      signal: options.signal,
      workflow,
    }),
  }
}
