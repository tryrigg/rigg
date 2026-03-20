export const CompileDiagnosticCode = {
  InvalidExpression: "invalid_expression",
  InvalidInputValue: "invalid_input_value",
  ProjectNotFound: "project_not_found",
  ReferenceError: "reference_error",
  ReadFailed: "read_failed",
  ValidationFailed: "validation_failed",
  InvalidYaml: "invalid_yaml",
  InvalidWorkflow: "invalid_workflow",
  DuplicateWorkflowId: "duplicate_workflow_id",
} as const

export type CompileDiagnosticCode = (typeof CompileDiagnosticCode)[keyof typeof CompileDiagnosticCode]

export type CompileDiagnostic = {
  code: CompileDiagnosticCode
  message: string
  filePath?: string
  cause?: Error
}

export function createDiag(
  code: CompileDiagnosticCode,
  message: string,
  options: {
    filePath?: string
    cause?: Error
  } = {},
): CompileDiagnostic {
  const compileDiagnostic: CompileDiagnostic = {
    code,
    message,
  }

  if (options.filePath !== undefined) {
    compileDiagnostic.filePath = options.filePath
  }

  if (options.cause !== undefined) {
    compileDiagnostic.cause = options.cause
  }

  return compileDiagnostic
}

export function isDiag(value: unknown): value is CompileDiagnostic {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  )
}
