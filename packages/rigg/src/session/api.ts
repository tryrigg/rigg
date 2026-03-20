import type { WorkflowProject } from "../project"
import { workflowById } from "../project"
import type { RunControlHandler, RunEvent } from "./event"
import type { RunSnapshot } from "./schema"
import { executeWorkflow } from "./engine"
import { normalizeInputs } from "./input"

export type RunWorkflowResult =
  | { kind: "completed"; snapshot: RunSnapshot }
  | { kind: "workflow_not_found"; message: string }
  | { kind: "invalid_input"; errors: string[] }

export async function runWorkflow(options: {
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

  const inputs = normalizeInputs(workflow, options.invocationInputs)
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
