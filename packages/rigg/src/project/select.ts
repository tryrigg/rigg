import type { WorkflowDocument } from "../workflow/schema"
import type { WorkflowProject } from "./model"

export function workflowById(project: WorkflowProject, workflowId: string): WorkflowDocument | undefined {
  return project.files.find((file) => file.workflow.id === workflowId)?.workflow
}
