export type WorkspacePaths = {
  rootDir: string
  riggDir: string
}

export type WorkflowSourceFile = {
  filePath: string
  relativePath: string
  text: string
}

export type DecodedWorkflowFile = {
  filePath: string
  relativePath: string
  workflow: import("../workflow/schema").WorkflowDocument
}

export type WorkflowProject = {
  workspace: WorkspacePaths
  files: DecodedWorkflowFile[]
}
