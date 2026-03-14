import type { WorkflowProject } from "../compile/index"
import { workflowById } from "../compile/project"
import type { RunSnapshot } from "../history/index"
import type { RunProgressEvent } from "./progress"
import { executeWorkflow } from "./execute"
import { normalizeInvocationInputs } from "./plan"

export type RunWorkflowResult =
  | { kind: "completed"; snapshot: RunSnapshot }
  | { kind: "workflow_not_found"; message: string }
  | { kind: "invalid_input"; errors: string[] }

export async function runWorkflowCommand(options: {
  configFiles: string[]
  cwd: string
  invocationInputs: Record<string, unknown>
  onProgress?: ((event: RunProgressEvent) => void) | undefined
  parentEnv: Record<string, string | undefined>
  project: WorkflowProject
  toolVersion: string
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
      configFiles: options.configFiles,
      cwd: options.cwd,
      invocationInputs: inputs.inputs,
      onProgress: options.onProgress,
      parentEnv: options.parentEnv,
      projectRoot: options.project.workspace.rootDir,
      toolVersion: options.toolVersion,
      workflow,
    }),
  }
}
