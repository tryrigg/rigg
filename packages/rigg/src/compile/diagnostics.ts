export const CompileErrorCode = {
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

export type CompileErrorCode = (typeof CompileErrorCode)[keyof typeof CompileErrorCode]

export type CompileError = {
  code: CompileErrorCode
  message: string
  filePath?: string
  cause?: Error
}

export function createCompileError(
  code: CompileErrorCode,
  message: string,
  options: {
    filePath?: string
    cause?: Error
  } = {},
): CompileError {
  const compileError: CompileError = {
    code,
    message,
  }

  if (options.filePath !== undefined) {
    compileError.filePath = options.filePath
  }

  if (options.cause !== undefined) {
    compileError.cause = options.cause
  }

  return compileError
}

export function isCompileError(value: unknown): value is CompileError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  )
}
