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
  line?: number
  column?: number
  snippet?: string
  hints?: string[]
}

export function createDiag(
  code: CompileDiagnosticCode,
  message: string,
  options: {
    filePath?: string
    cause?: Error
    line?: number
    column?: number
    snippet?: string
    hints?: string[]
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

  if (options.line !== undefined) {
    compileDiagnostic.line = options.line
  }

  if (options.column !== undefined) {
    compileDiagnostic.column = options.column
  }

  if (options.snippet !== undefined) {
    compileDiagnostic.snippet = options.snippet
  }

  if (options.hints !== undefined && options.hints.length > 0) {
    compileDiagnostic.hints = options.hints
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
